// src/discovery/openai-client.ts — Real OpenAI LLM client behind the decide() seam.
// v2: trajectory memory — system prompt once, alternating observation/action turns.
// Supports both Chat Completions (gpt-4o class) and Responses API (reasoning models).

import OpenAI from 'openai';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LLMClient, DecisionContext, ToolCall } from './llm-client.js';
import type { ElementInfo } from '../surface/surface.js';

// ── Tiny .env loader (no dotenv dep) ────────────────────────
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;  // skip comments and blanks robustly
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.substring(0, eq).trim();
    const val = line.substring(eq + 1).trim().replace(/\r$/, '');
    if (/^[A-Z_][A-Z_0-9]*$/.test(key) && !process.env[key]) {
      process.env[key] = val;
    }
  }
}

// ── Observation compaction ──────────────────────────────────
const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'img']);
const MAX_ELEMENTS = 80;

function compactObservation(obs: { url: string; elements: ElementInfo[] }, prevObs?: { url: string; elements: ElementInfo[] } | null): string {
  const lines: string[] = [`URL: ${obs.url}`];
  if (prevObs) {
    const changes: string[] = [];
    if (prevObs.url !== obs.url) changes.push(`page navigated: ${prevObs.url} → ${obs.url}`);
    const prevFrames = new Set(prevObs.elements.map(e => e.frame));
    const curFrames = new Set(obs.elements.map(e => e.frame));
    for (const f of curFrames) { if (!prevFrames.has(f)) changes.push(`new frame: ${f}`); }
    for (const f of prevFrames) { if (!curFrames.has(f)) changes.push(`frame removed: ${f}`); }
    if (changes.length > 0) lines.push(`CHANGES: ${changes.join('; ')}`);
  }

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

  const frames = [...new Set(selected.map(e => e.frame))];
  for (const frameName of frames) {
    const frameEls = selected.filter(e => e.frame === frameName);
    const frameUrl = frameEls.find(e => e.frameUrl)?.frameUrl;
    const urlSuffix = frameUrl ? ` (${(() => { try { return new URL(frameUrl).pathname; } catch { return frameUrl; } })()})` : '';
    lines.push(`--- frame: ${frameName}${urlSuffix} ---`);
    for (const el of frameEls) {
      const name = (el.name || '').substring(0, 60).replace(/\n/g, ' ');
      const near = el.nearbyText ? ` near:"${el.nearbyText.substring(0, 40)}"` : '';
      const col = el.columnHeader ? ` col:"${el.columnHeader}"` : '';
      const val = el.value ? ` val:"${el.value.substring(0, 30)}"` : '';
      let opts = '';
      if (el.options && el.options.length > 0) {
        const shown = el.options.slice(0, 15).map(o => `"${o.substring(0, 25)}"`).join(', ');
        const more = el.options.length > 15 ? ` +${el.options.length - 15} more` : '';
        const selected = el.value ? ` selected: "${el.value.substring(0, 25)}"` : '';
        opts = ` options: [${shown}${more}]${selected}`;
      }
      const moneyHint = el.role === 'cell' && /\$[\d,]+\.\d{2}/.test(el.name || '') ? ' [MONEY]' : '';
      lines.push(`${el.ref} ${el.role} "${name}"${col}${near}${val}${opts}${moneyHint}`);
    }
  }
  return lines.join('\n');
}

// ── Domain-neutral system prompt ────────────────────────────
// Interpolated with appDescription from the discovery contract.
function buildSystemPrompt(appDescription?: string): string {
  const appDesc = appDescription || 'a web application';
  return `You are an automation agent controlling ${appDesc} through a browser. Your job: accomplish the stated goal by interacting with the page one action at a time.

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
   {"textPresent":"Dashboard"} | {"elementValue":{"$self":true}} | {"outputPopulated":"balance"}
5. If the value matches a declared input, set paramHint to the input name.
6. For read, set outputName to the declared output name.
7. Call "done" only when ALL outputs are populated. The system verifies.
8. Log in using the provided credential values.
9. Navigate with app-relative paths ("/search", "/login").
10. Be methodical: login → navigate → search → read.
11. Data tables may be in iframes (frame != "main"). Look for cells with col:"Balance".
12. For money outputs, target the cell whose text starts with "$" and has col:"Balance" and [MONEY] tag.
13. After the journal shows "OUTPUT_POPULATED", immediately call done.
14. After typing into a search form, ALWAYS click the submit/search button.
15. Pages may use HTML framesets — clicking in one frame updates another. Look for new elements in ALL frames.
16. For combobox/select elements, use the "select" verb with one of the listed option values.
17. If a step fails with AMBIGUOUS, read the candidate breakdown to pick a different strategy — navigate to a detail page, or target a more specific element.`;
}

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

// ── History turn (elided or full) ───────────────────────────
interface HistoryTurn {
  observation: string;       // compacted observation text
  screenshotPath?: string;   // for the most recent turns
  action: string;            // tool call JSON summary
  result: string;            // verified result line
  url: string;               // for elision
}

const RECENT_WINDOW = 2; // keep full observations for last 2 turns

// ── OpenAI LLM Client ──────────────────────────────────────
export class OpenAIClient implements LLMClient {
  private client: OpenAI;
  private model: string;
  private apiStyle: 'responses' | 'chat';
  private totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  private onUsage?: (turn: number, usage: TokenUsage) => void;
  private turnCount = 0;
  private prevObservation: { url: string; elements: ElementInfo[] } | null = null;
  private history: HistoryTurn[] = [];
  private appDescription?: string;
  private noMemory: boolean;

  constructor(opts?: { onUsage?: (turn: number, usage: TokenUsage) => void; appDescription?: string; noMemory?: boolean }) {
    loadEnvFile(resolve(process.cwd(), '.env'));
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    this.model = process.env.OPENAI_MODEL || 'gpt-4o';
    this.apiStyle = detectApiStyle(this.model);
    this.client = new OpenAI({ apiKey });
    this.onUsage = opts?.onUsage;
    this.appDescription = opts?.appDescription;
    this.noMemory = opts?.noMemory || process.env.NO_MEMORY === '1';
  }

  getApiStyle(): string { return this.apiStyle; }
  getTotalUsage(): TokenUsage { return { ...this.totalUsage }; }

  /** Record the result of the last action (called by agent after verify). */
  recordResult(resultLine: string): void {
    if (this.history.length > 0) {
      this.history[this.history.length - 1].result = resultLine;
    }
  }

  async decide(ctx: DecisionContext): Promise<ToolCall> {
    this.turnCount++;
    return this.apiStyle === 'responses'
      ? this.decideViaResponses(ctx)
      : this.decideViaChat(ctx);
  }

  // ── Chat Completions path ────────────────────────────────────

  private async decideViaChat(ctx: DecisionContext): Promise<ToolCall> {
    const messages = this.buildMessages(ctx);

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
        const toolCall = this.parseToolCall(fn.name ?? '', fn.arguments ?? '{}');
        this.recordAction(ctx, toolCall);
        return toolCall;
      } catch (e) {
        console.error(`[Chat attempt ${attempt}] ${(e as Error).message}`);
        if (attempt === 0) continue;
        return { tool: 'done', summary: `API error: ${(e as Error).message}` };
      }
    }
    return { tool: 'done', summary: 'Failed after retry' };
  }

  // ── Responses API path ───────────────────────────────────────

  private async decideViaResponses(ctx: DecisionContext): Promise<ToolCall> {
    const input = this.buildResponsesInput(ctx);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await (this.client as any).responses.create({
          model: this.model, input, tools: TOOLS_RESPONSES, tool_choice: 'required',
        });
        if (response.usage) {
          const reasoning = response.usage.output_tokens_details?.reasoning_tokens ?? 0;
          this.trackUsage(response.usage.input_tokens ?? 0, response.usage.output_tokens ?? 0, reasoning);
        }
        const output = response.output ?? [];
        const fc = output.find((o: any) => o.type === 'function_call');
        if (!fc) { if (attempt === 0) continue; return { tool: 'done', summary: 'No function call in response' }; }
        const toolCall = this.parseToolCall(fc.name ?? '', fc.arguments ?? '{}');
        this.recordAction(ctx, toolCall);
        return toolCall;
      } catch (e) {
        console.error(`[Responses attempt ${attempt}] ${(e as Error).message}`);
        if (attempt === 0) continue;
        return { tool: 'done', summary: `API error: ${(e as Error).message}` };
      }
    }
    return { tool: 'done', summary: 'Failed after retry' };
  }

  // ── Message history building ─────────────────────────────────

  private buildMessages(ctx: DecisionContext): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    if (this.noMemory) {
      // Single-prompt mode (12.2 era): system + one user message with everything
      const userText = this.buildContractContext(ctx) + '\n' + this.buildCurrentObservation(ctx);
      const parts: any[] = [{ type: 'text', text: userText }];
      if (ctx.observation.screenshotPath && existsSync(ctx.observation.screenshotPath)) {
        const base64 = readFileSync(ctx.observation.screenshotPath).toString('base64');
        parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'low' } });
      }
      return [
        { role: 'system', content: buildSystemPrompt(this.appDescription) },
        { role: 'user', content: parts },
      ];
    }
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(this.appDescription) },
    ];

    // Add contract context as first user message
    messages.push({ role: 'user', content: this.buildContractContext(ctx) });

    // Add history turns (elided older, full recent)
    for (let i = 0; i < this.history.length; i++) {
      const turn = this.history[i];
      const isRecent = i >= this.history.length - RECENT_WINDOW;

      if (isRecent) {
        // Full observation
        const parts: any[] = [{ type: 'text', text: turn.observation }];
        if (turn.screenshotPath && existsSync(turn.screenshotPath)) {
          const base64 = readFileSync(turn.screenshotPath).toString('base64');
          parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'low' } });
        }
        messages.push({ role: 'user', content: parts });
      } else {
        // Elided to one line
        messages.push({ role: 'user', content: `turn ${i + 1}: ${turn.url} — ${turn.action} → ${turn.result}` });
      }

      // The model's action for this turn
      messages.push({ role: 'assistant', content: turn.action });
    }

    // Current observation (the new tick)
    const obsText = this.buildCurrentObservation(ctx);
    const parts: any[] = [{ type: 'text', text: obsText }];
    if (ctx.observation.screenshotPath && existsSync(ctx.observation.screenshotPath)) {
      const base64 = readFileSync(ctx.observation.screenshotPath).toString('base64');
      parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'low' } });
    }
    messages.push({ role: 'user', content: parts });

    return messages;
  }

  private buildResponsesInput(ctx: DecisionContext): any[] {
    if (this.noMemory) {
      const userText = this.buildContractContext(ctx) + '\n' + this.buildCurrentObservation(ctx);
      const parts: any[] = [{ type: 'input_text', text: userText }];
      if (ctx.observation.screenshotPath && existsSync(ctx.observation.screenshotPath)) {
        const base64 = readFileSync(ctx.observation.screenshotPath).toString('base64');
        parts.push({ type: 'input_image', image_url: `data:image/png;base64,${base64}` });
      }
      return [
        { role: 'system', content: buildSystemPrompt(this.appDescription) },
        { role: 'user', content: parts },
      ];
    }
    const input: any[] = [
      { role: 'system', content: buildSystemPrompt(this.appDescription) },
    ];

    // Contract context
    input.push({ role: 'user', content: [{ type: 'input_text', text: this.buildContractContext(ctx) }] });

    // History turns
    for (let i = 0; i < this.history.length; i++) {
      const turn = this.history[i];
      const isRecent = i >= this.history.length - RECENT_WINDOW;

      if (isRecent) {
        const parts: any[] = [{ type: 'input_text', text: turn.observation }];
        if (turn.screenshotPath && existsSync(turn.screenshotPath)) {
          const base64 = readFileSync(turn.screenshotPath).toString('base64');
          parts.push({ type: 'input_image', image_url: `data:image/png;base64,${base64}` });
        }
        input.push({ role: 'user', content: parts });
      } else {
        input.push({ role: 'user', content: [{ type: 'input_text', text: `turn ${i + 1}: ${turn.url} — ${turn.action} → ${turn.result}` }] });
      }

      input.push({ role: 'assistant', content: [{ type: 'output_text', text: turn.action }] });
    }

    // Current observation
    const obsText = this.buildCurrentObservation(ctx);
    const parts: any[] = [{ type: 'input_text', text: obsText }];
    if (ctx.observation.screenshotPath && existsSync(ctx.observation.screenshotPath)) {
      const base64 = readFileSync(ctx.observation.screenshotPath).toString('base64');
      parts.push({ type: 'input_image', image_url: `data:image/png;base64,${base64}` });
    }
    input.push({ role: 'user', content: parts });

    return input;
  }

  private buildContractContext(ctx: DecisionContext): string {
    const parts: string[] = [];
    parts.push(`GOAL: ${ctx.goal}`);
    parts.push(`\nCONTRACT:`);
    parts.push(`  Capability: ${ctx.contract.name}`);
    parts.push(`  Inputs (use these exact values when typing):`);
    for (const [k, v] of Object.entries(ctx.contract.inputs)) {
      parts.push(`    ${k} (${v.type}) = "${v.exampleValue ?? ''}"`);
    }
    parts.push(`  Outputs needed: ${Object.entries(ctx.contract.outputs).map(([k, v]) => `${k} (${v.type})`).join(', ')}`);
    return parts.join('\n');
  }

  private buildCurrentObservation(ctx: DecisionContext): string {
    const parts: string[] = [];
    // Include recent journal entries in the observation
    if (ctx.journal.length > 0) {
      const recent = ctx.journal.slice(-5);
      parts.push(`RECENT JOURNAL (${ctx.journal.length} total, showing last ${recent.length}):`);
      for (const line of recent) parts.push(`  ${line}`);
    }
    parts.push(`\n${compactObservation(ctx.observation, this.prevObservation)}`);
    this.prevObservation = { url: ctx.observation.url, elements: ctx.observation.elements };
    return parts.join('\n');
  }

  private recordAction(ctx: DecisionContext, toolCall: ToolCall): void {
    const actionStr = toolCall.tool === 'done'
      ? `done: ${toolCall.summary}`
      : `${(toolCall as any).verb} ${(toolCall as any).targetRef ?? ''} ${(toolCall as any).value ?? ''}`.trim();

    this.history.push({
      observation: compactObservation(ctx.observation, this.prevObservation),
      screenshotPath: ctx.observation.screenshotPath,
      action: actionStr,
      result: '(pending)', // will be set by recordResult()
      url: ctx.observation.url,
    });
  }

  // ── Shared helpers ────────────────────────────────────────

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
