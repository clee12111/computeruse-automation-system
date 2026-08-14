// src/discovery/openai-client.ts — Real OpenAI LLM client behind the decide() seam.
// DESIGN_MAP D5: temp 0, one tool call per turn, vision-capable model.
// Supports both Chat Completions (gpt-4o class) and Responses API (reasoning models).

import OpenAI from 'openai';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LLMClient, DecisionContext, ToolCall } from './llm-client.js';
import type { ElementInfo } from '../surface/surface.js';

// ── Tiny .env loader (no dotenv dep) ────────────────────────
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ── Observation compaction ──────────────────────────────────
const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'img']);
const MAX_ELEMENTS = 80;

function compactObservation(obs: { url: string; elements: ElementInfo[] }): string {
  const lines: string[] = [`URL: ${obs.url}`];
  const interactive: ElementInfo[] = [];
  const other: ElementInfo[] = [];
  for (const el of obs.elements) {
    if (INTERACTIVE_ROLES.has(el.role)) interactive.push(el);
    else if (el.name && el.name.trim().length > 0) other.push(el);
  }
  const moneyCells = other.filter(e => e.role === 'cell' && /\$[\d,]+\.\d{2}/.test(e.name || ''));
  const nonMoneyCells = other.filter(e => !(e.role === 'cell' && /\$[\d,]+\.\d{2}/.test(e.name || '')));
  const selected = [...moneyCells, ...interactive];
  const remaining = MAX_ELEMENTS - selected.length;
  if (remaining > 0) selected.push(...nonMoneyCells.slice(0, remaining));
  const omitted = obs.elements.length - selected.length;
  lines.push(`Elements (${obs.elements.length} total, showing ${selected.length}${omitted > 0 ? `, ${omitted} omitted` : ''}):`);
  for (const el of selected) {
    const name = (el.name || '').substring(0, 60).replace(/\n/g, ' ');
    const near = el.nearbyText ? ` near:"${el.nearbyText.substring(0, 40)}"` : '';
    const col = el.columnHeader ? ` col:"${el.columnHeader}"` : '';
    const val = el.value ? ` val:"${el.value.substring(0, 30)}"` : '';
    const moneyHint = el.role === 'cell' && /\$[\d,]+\.\d{2}/.test(el.name || '') ? ' [MONEY]' : '';
    lines.push(`${el.ref} ${el.role} "${name}"${col}${near}${val} frame:${el.frame}${moneyHint}`);
  }
  return lines.join('\n');
}

// ── System prompt ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are an automation agent controlling a legacy credit union operator console through a browser. Your job: accomplish the stated goal by interacting with the page one action at a time.

RULES:
1. ONE action per turn. Call either the "act" tool or the "done" tool.
2. Verbs: click, type, select, read, navigate.
   - click: click an element. Needs targetRef.
   - type: type text into an input. Needs targetRef + value.
   - select: choose a dropdown option. Needs targetRef + value.
   - read: read text from an element. Needs targetRef + outputName.
   - navigate: go to an app-relative URL path. Needs value (e.g. "/search").
3. targetRef must be from the current observation (e.g. "e5"). NEVER invent refs.
4. Propose an expectProposal to verify the action:
   {"textPresent":"Dashboard"} | {"elementValue":{"$self":true}} | {"outputPopulated":"savingsBalance"}
5. If the value matches a declared input, set paramHint to the input name.
6. For read, set outputName to the declared output name.
7. Call "done" only when ALL outputs are populated. The system verifies.
8. Log in using the provided credential values.
9. Navigate with app-relative paths ("/search", "/login").
10. Be methodical: login → navigate → search → read.
11. Data tables may be in iframes (frame != "main"). Look for cells with col:"Balance".
12. For money outputs, target the cell whose text starts with "$" and has col:"Balance" and [MONEY] tag.
13. After the journal shows "OUTPUT_POPULATED", immediately call done.
14. After typing into a search form, ALWAYS click the submit/search button.`;

// ── Tool definitions ────────────────────────────────────────
const TOOLS_CHAT: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'act', description: 'Perform one action on the page', strict: false, parameters: {
    type: 'object', required: ['verb', 'intent', 'expectProposal'], properties: {
      verb: { type: 'string', enum: ['click', 'type', 'select', 'read', 'navigate'] },
      targetRef: { type: 'string', description: 'Element ref (e.g. "e5")' },
      value: { type: 'string', description: 'Value to type/select, or path for navigate' },
      outputName: { type: 'string', description: 'For read: output name' },
      intent: { type: 'string', description: 'Why this action' },
      expectProposal: { type: 'object', description: 'Verification predicate' },
      paramHint: { type: 'string', description: 'Input parameter name if applicable' },
    },
  }}},
  { type: 'function', function: { name: 'done', description: 'Goal complete (system verifies outputs)', strict: false, parameters: {
    type: 'object', required: ['summary'], properties: { summary: { type: 'string' } },
  }}},
];

// Responses API tools use a slightly different shape
const TOOLS_RESPONSES = TOOLS_CHAT.map(t => {
  const fn = (t as any).function;
  return { type: 'function' as const, name: fn.name, description: fn.description, parameters: fn.parameters };
});

// ── API style detection ─────────────────────────────────────
const REASONING_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'];

function detectApiStyle(model: string): 'responses' | 'chat' {
  const envStyle = process.env.OPENAI_API_STYLE;
  if (envStyle === 'responses' || envStyle === 'chat') return envStyle;
  return REASONING_PREFIXES.some(p => model.startsWith(p)) ? 'responses' : 'chat';
}

// ── Token usage tracking ────────────────────────────────────
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

// ── OpenAI LLM Client ──────────────────────────────────────
export class OpenAIClient implements LLMClient {
  private client: OpenAI;
  private model: string;
  private apiStyle: 'responses' | 'chat';
  private totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  private onUsage?: (turn: number, usage: TokenUsage) => void;
  private turnCount = 0;

  constructor(opts?: { onUsage?: (turn: number, usage: TokenUsage) => void }) {
    loadEnvFile(resolve(process.cwd(), '.env'));
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    this.model = process.env.OPENAI_MODEL || 'gpt-4o';
    this.apiStyle = detectApiStyle(this.model);
    this.client = new OpenAI({ apiKey });
    this.onUsage = opts?.onUsage;
  }

  getApiStyle(): string { return this.apiStyle; }
  getTotalUsage(): TokenUsage { return { ...this.totalUsage }; }

  async decide(ctx: DecisionContext): Promise<ToolCall> {
    this.turnCount++;
    return this.apiStyle === 'responses'
      ? this.decideViaResponses(ctx)
      : this.decideViaChat(ctx);
  }

  // ── Chat Completions path (gpt-4o, gpt-4.1) ──────────────

  private async decideViaChat(ctx: DecisionContext): Promise<ToolCall> {
    const userParts = this.buildUserParts(ctx);
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userParts },
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model, messages, tools: TOOLS_CHAT, tool_choice: 'required',
          ...(this.model.startsWith('gpt-4') ? { temperature: 0 } : {}),
          max_completion_tokens: 500,
        });
        if (response.usage) this.trackUsage(response.usage.prompt_tokens ?? 0, response.usage.completion_tokens ?? 0, 0);
        const choice = response.choices[0];
        if (!choice?.message?.tool_calls?.length) { if (attempt === 0) continue; return { tool: 'done', summary: 'No tool call' }; }
        const tc = choice.message.tool_calls[0] as any;
        const fn = tc.function ?? tc;
        return this.parseToolCall(fn.name ?? '', fn.arguments ?? '{}');
      } catch (e) {
        console.error(`[Chat attempt ${attempt}] ${(e as Error).message}`);
        if (attempt === 0) continue;
        return { tool: 'done', summary: `API error: ${(e as Error).message}` };
      }
    }
    return { tool: 'done', summary: 'Failed after retry' };
  }

  // ── Responses API path (gpt-5 class, reasoning models) ────

  private async decideViaResponses(ctx: DecisionContext): Promise<ToolCall> {
    const userParts = this.buildUserParts(ctx);
    const input: any[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userParts },
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await (this.client as any).responses.create({
          model: this.model,
          input,
          tools: TOOLS_RESPONSES,
          tool_choice: 'required',
        });

        // Track usage
        if (response.usage) {
          const reasoning = response.usage.output_tokens_details?.reasoning_tokens ?? 0;
          this.trackUsage(response.usage.input_tokens ?? 0, response.usage.output_tokens ?? 0, reasoning);
        }

        // Find function_call in output
        const output = response.output ?? [];
        const fc = output.find((o: any) => o.type === 'function_call');
        if (!fc) { if (attempt === 0) continue; return { tool: 'done', summary: 'No function call in response' }; }
        return this.parseToolCall(fc.name ?? '', fc.arguments ?? '{}');
      } catch (e) {
        console.error(`[Responses attempt ${attempt}] ${(e as Error).message}`);
        if (attempt === 0) continue;
        return { tool: 'done', summary: `API error: ${(e as Error).message}` };
      }
    }
    return { tool: 'done', summary: 'Failed after retry' };
  }

  // ── Shared helpers ────────────────────────────────────────

  private buildUserParts(ctx: DecisionContext): any[] {
    if (this.apiStyle === 'responses') {
      // Responses API: input_text / input_image
      const parts: any[] = [{ type: 'input_text', text: this.buildUserMessage(ctx) }];
      if (ctx.observation.screenshotPath && existsSync(ctx.observation.screenshotPath)) {
        const base64 = readFileSync(ctx.observation.screenshotPath).toString('base64');
        parts.push({ type: 'input_image', image_url: `data:image/png;base64,${base64}` });
      }
      return parts;
    }
    // Chat Completions API: text / image_url
    const parts: any[] = [{ type: 'text', text: this.buildUserMessage(ctx) }];
    if (ctx.observation.screenshotPath && existsSync(ctx.observation.screenshotPath)) {
      const base64 = readFileSync(ctx.observation.screenshotPath).toString('base64');
      parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'low' } });
    }
    return parts;
  }

  private buildUserMessage(ctx: DecisionContext): string {
    const parts: string[] = [];
    parts.push(`GOAL: ${ctx.goal}`);
    parts.push(`\nCONTRACT:`);
    parts.push(`  Capability: ${ctx.contract.name}`);
    parts.push(`  Inputs (use these exact values when typing):`);
    for (const [k, v] of Object.entries(ctx.contract.inputs)) {
      parts.push(`    ${k} (${v.type}) = "${v.exampleValue ?? ''}"`);
    }
    parts.push(`  Outputs needed: ${Object.entries(ctx.contract.outputs).map(([k, v]) => `${k} (${v.type})`).join(', ')}`);
    if (ctx.journal.length > 0) {
      parts.push(`\nJOURNAL (${ctx.journal.length} entries):`);
      for (const line of ctx.journal.slice(-10)) parts.push(`  ${line}`);
    }
    parts.push(`\n${compactObservation(ctx.observation)}`);
    return parts.join('\n');
  }

  private parseToolCall(name: string, argsJson: string): ToolCall {
    const args = JSON.parse(argsJson);
    if (name === 'done') return { tool: 'done', summary: args.summary ?? 'Done' };
    if (name === 'act') return {
      tool: 'act', verb: args.verb, targetRef: args.targetRef, value: args.value,
      outputName: args.outputName, intent: args.intent ?? 'action',
      expectProposal: args.expectProposal ?? { textPresent: 'page' }, paramHint: args.paramHint,
    };
    return { tool: 'done', summary: `Unknown tool: ${name}` };
  }

  private trackUsage(prompt: number, completion: number, reasoning: number): void {
    const usage: TokenUsage = { promptTokens: prompt, completionTokens: completion, reasoningTokens: reasoning, totalTokens: prompt + completion };
    this.totalUsage.promptTokens += usage.promptTokens;
    this.totalUsage.completionTokens += usage.completionTokens;
    this.totalUsage.reasoningTokens += usage.reasoningTokens;
    this.totalUsage.totalTokens += usage.totalTokens;
    this.onUsage?.(this.turnCount, usage);
  }
}
