// src/discovery/openai-client.ts — Real OpenAI LLM client behind the decide() seam.
// DESIGN_MAP D5: temp 0, one tool call per turn, vision-capable model.
// No dotenv dependency — tiny .env parser inline.

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
    if (INTERACTIVE_ROLES.has(el.role)) {
      interactive.push(el);
    } else if (el.name && el.name.trim().length > 0) {
      other.push(el);
    }
  }

  // Money cells first (highest signal for read actions), then interactive, then other
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
1. ONE action per turn. Call either the "act" tool (to interact with the page) or the "done" tool (when the goal is complete).
2. Choose a verb from: click, type, select, read, navigate.
   - click: click an element (button, link). Needs targetRef.
   - type: type text into an input. Needs targetRef + value.
   - select: choose an option in a dropdown. Needs targetRef + value.
   - read: read text from an element (e.g. a table cell). Needs targetRef + outputName.
   - navigate: go to an app-relative URL path. Needs value (e.g. "/search").
3. targetRef must be an element ref from the current observation (e.g. "e5"). NEVER invent refs — only use what you see.
4. For each action, propose an expectProposal — a predicate to verify the action worked:
   - {"textPresent":"Dashboard"} — text is now visible on the page
   - {"elementValue":{"$self":true}} — the input now has the value you typed
   - {"outputPopulated":"savingsBalance"} — a read action populated this output
   - {"textAbsent":"error"} — text is NOT visible
5. If the value you type/enter is one of the declared input parameters, set paramHint to the input name (e.g. "memberId"). This helps the system record the action correctly.
6. For read actions, set outputName to the declared output you want to save the read value to.
7. Call "done" only when you believe ALL declared outputs have been populated. The system will verify — if outputs are missing, you'll see an error and must continue.
8. If you see a login page, log in using the provided credential values.
9. Navigate using app-relative paths (e.g. "/search", "/login"), not full URLs.
10. Be methodical: login → navigate to the right page → search → read the data.
11. Data tables may be in iframes (frame != "main"). Look for cells there.
12. CRITICAL for read: find the cell whose col:"Balance" AND whose text starts with "$". That is the money value. Target THAT element's ref for the read action with outputName.
13. After the journal shows "OUTPUT_POPULATED: <outputName>", immediately call done.
14. After typing into a search form, ALWAYS click the submit/search button to trigger the search.`;

// ── Tool definitions ────────────────────────────────────────
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'act',
      description: 'Perform one action on the page',
      strict: false,
      parameters: {
        type: 'object',
        required: ['verb', 'intent', 'expectProposal'],
        properties: {
          verb: { type: 'string', enum: ['click', 'type', 'select', 'read', 'navigate'], description: 'Action type' },
          targetRef: { type: 'string', description: 'Element ref from observation (e.g. "e5"). Required for click/type/select/read.' },
          value: { type: 'string', description: 'Value to type/select, or path for navigate' },
          outputName: { type: 'string', description: 'For read: which declared output to save to' },
          intent: { type: 'string', description: 'Why this action (1 sentence)' },
          expectProposal: { type: 'object', description: 'Verification predicate. E.g. {"textPresent":"Dashboard"} or {"elementValue":{"$self":true}}' },
          paramHint: { type: 'string', description: 'If value is a declared input, name it (e.g. "memberId")' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Declare the goal is complete (system will verify outputs)',
      strict: false,
      parameters: {
        type: 'object',
        required: ['summary'],
        properties: {
          summary: { type: 'string', description: 'What was accomplished' },
        },
      },
    },
  },
];

// ── Token usage tracking ────────────────────────────────────
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ── OpenAI LLM Client ──────────────────────────────────────
export class OpenAIClient implements LLMClient {
  private client: OpenAI;
  private model: string;
  private totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private onUsage?: (turn: number, usage: TokenUsage) => void;
  private turnCount = 0;

  constructor(opts?: { onUsage?: (turn: number, usage: TokenUsage) => void }) {
    // Load .env if present
    loadEnvFile(resolve(process.cwd(), '.env'));

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    this.model = process.env.OPENAI_MODEL || 'gpt-4o';
    this.client = new OpenAI({ apiKey });
    this.onUsage = opts?.onUsage;
  }

  getTotalUsage(): TokenUsage { return { ...this.totalUsage }; }

  async decide(ctx: DecisionContext): Promise<ToolCall> {
    this.turnCount++;
    const userContent = this.buildUserMessage(ctx);

    // Build messages with optional screenshot
    const userParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: userContent },
    ];

    // Add screenshot if available
    if (ctx.observation.screenshotPath && existsSync(ctx.observation.screenshotPath)) {
      const imgData = readFileSync(ctx.observation.screenshotPath);
      const base64 = imgData.toString('base64');
      userParts.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${base64}`, detail: 'low' },
      });
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userParts },
    ];

    // Call the API (one retry for malformed response)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages,
          tools: TOOLS,
          tool_choice: 'required',
          ...(this.model.startsWith('gpt-4') ? { temperature: 0 } : {}),
          max_completion_tokens: 500,
        });

        // Track usage
        if (response.usage) {
          const usage: TokenUsage = {
            promptTokens: response.usage.prompt_tokens ?? 0,
            completionTokens: response.usage.completion_tokens ?? 0,
            totalTokens: response.usage.total_tokens ?? 0,
          };
          this.totalUsage.promptTokens += usage.promptTokens;
          this.totalUsage.completionTokens += usage.completionTokens;
          this.totalUsage.totalTokens += usage.totalTokens;
          this.onUsage?.(this.turnCount, usage);
        }

        // Parse tool call
        const choice = response.choices[0];
        if (!choice?.message?.tool_calls?.length) {
          if (attempt === 0) continue; // retry
          return { tool: 'done', summary: 'No tool call returned' };
        }

        const tc = choice.message.tool_calls[0] as { type: string; function?: { name: string; arguments: string } };
        const fn = tc.function ?? (tc as any);
        const fnName = fn.name ?? '';
        const args = JSON.parse(fn.arguments ?? '{}');

        if (fnName === 'done') {
          return { tool: 'done', summary: args.summary ?? 'Done' };
        }

        if (fnName === 'act') {
          return {
            tool: 'act',
            verb: args.verb,
            targetRef: args.targetRef,
            value: args.value,
            outputName: args.outputName,
            intent: args.intent ?? 'action',
            expectProposal: args.expectProposal ?? { textPresent: 'page' },
            paramHint: args.paramHint,
          };
        }

        // Unknown tool — retry
        if (attempt === 0) continue;
        return { tool: 'done', summary: `Unknown tool: ${fnName}` };

      } catch (e) {
        console.error(`[OpenAI attempt ${attempt}] Error:`, (e as Error).message);
        if (attempt === 0) continue; // retry
        return { tool: 'done', summary: `API error: ${(e as Error).message}` };
      }
    }

    return { tool: 'done', summary: 'Failed after retry' };
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

    // Input values (for context — the model needs to know what to type)
    // Note: sensitive values are in ctx but will be redacted in the journal
    if (ctx.journal.length > 0) {
      parts.push(`\nJOURNAL (${ctx.journal.length} entries):`);
      for (const line of ctx.journal.slice(-10)) { // last 10 entries
        parts.push(`  ${line}`);
      }
    }

    parts.push(`\n${compactObservation(ctx.observation)}`);

    return parts.join('\n');
  }
}
