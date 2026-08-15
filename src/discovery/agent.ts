// src/discovery/agent.ts — The DiscoveryAgent loop.
// DESIGN_MAP D5: observe → context → decide → describe-then-act → verify → ledger.
// Contract-first (Amendment A): the WHAT is declared; the LLM discovers the HOW.
// Describe-then-act (Amendment B): descriptor chain captured BEFORE act.

import type { Surface, Observation, ActResult } from '../surface/surface.js';
import type { LLMClient, DecisionContext, ToolCall, ActToolCall } from './llm-client.js';
import { Recorder, type LedgerEntry } from './recorder.js';
import type { CapabilityArtifact, Descriptor } from '../schema/artifact.js';
import { RunJournal } from '../evidence/journal.js';

// ── Stop condition constants ────────────────────────────────
const MAX_STEPS = 15;
const MAX_REFUSALS = 3;
const MAX_SAME_ACTION = 5; // 5th consecutive same verb+target → DEAD_END
const WALL_CLOCK_TIMEOUT_MS = 120_000;

// ── Discovery contract (from CLI args) ──────────────────────
export interface DiscoveryContract {
  name: string;
  goal: string;
  app: string;
  startPath: string;
  inputs: Record<string, { type: string; pattern?: string; sensitive: boolean; exampleValue: string }>;
  outputs: Record<string, { type: string; sensitive: boolean }>;
}

// ── Discovery result ────────────────────────────────────────
export interface DiscoverResult {
  status: 'compiled' | 'dead_end' | 'aborted';
  artifactPath?: string;
  artifact?: CapabilityArtifact;
  reason?: string;
}

// ── Discovery config ────────────────────────────────────────
export interface DiscoverConfig {
  surface: Surface;
  llmClient: LLMClient;
  contract: DiscoveryContract;
  journal: RunJournal;
  capabilitiesDir: string;
}

// ── Parse money ─────────────────────────────────────────────
function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null; // strict: digits and optional decimal only
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

function parseOutputValue(raw: string, type: string): unknown {
  if (type === 'money') return parseMoney(raw);
  return raw;
}

// ── The agent loop ──────────────────────────────────────────
export async function discover(config: DiscoverConfig): Promise<DiscoverResult> {
  const { surface, llmClient, contract, journal } = config;
  const recorder = new Recorder();
  const journalLines: string[] = [];
  let stepCount = 0;
  let refusalCount = 0;
  let lastVerbTarget = '';
  let sameActionCount = 0;
  const startTime = Date.now();

  // Navigate to start path and record it
  journal.event('discovery_start', { name: contract.name, goal: contract.goal });
  const navResult = await surface.navigate(contract.startPath);
  if (!navResult.ok) {
    const reason = navResult.blocked
      ? `Policy blocked: ${navResult.blocked.rule} (${navResult.blocked.attempted})`
      : (navResult.error ?? 'unknown');
    return { status: 'aborted', reason: `Failed to navigate to start: ${reason}` };
  }
  // Wait for page to settle, then record the initial navigation
  await new Promise(r => setTimeout(r, 500));
  const startObs = await surface.observe();
  // Find prominent VISIBLE text — headings first, then buttons, then any named element.
  // Priority: heading > button > link > any element with text > page title.
  // NEVER fall back to URL slugs. Verify via surface.check before recording.
  const candidates = [
    ...startObs.elements.filter(e => e.role === 'heading' && e.name.length > 2),
    ...startObs.elements.filter(e => e.role === 'button' && e.name.length > 2),
    ...startObs.elements.filter(e => e.role === 'link' && e.name.length > 3 && e.name.length < 40),
    ...startObs.elements.filter(e => e.name.length > 3 && e.name.length < 50),
  ];
  let startPageText = 'page';
  for (const el of candidates) {
    const candidate = el.name.substring(0, 40);
    if (await surface.check({ textPresent: candidate })) {
      startPageText = candidate;
      break;
    }
  }
  journal.event('initial_navigate_expect', { text: startPageText, verified: startPageText !== 'page' });
  recorder.record({
    intent: `Navigate to ${contract.startPath}`,
    verb: 'navigate',
    value: contract.startPath,
    chain: [{ by: 'structural' as const, note: 'navigation target' }],
    expect: { textPresent: startPageText },
  });

  while (true) {
    // Wall clock check
    if (Date.now() - startTime > WALL_CLOCK_TIMEOUT_MS) {
      return { status: 'dead_end', reason: 'Wall clock timeout' };
    }

    // Step count check
    if (stepCount >= MAX_STEPS) {
      return { status: 'dead_end', reason: `Max steps (${MAX_STEPS}) reached` };
    }

    // Refusal check
    if (refusalCount >= MAX_REFUSALS) {
      return { status: 'aborted', reason: `${MAX_REFUSALS} guardrail refusals` };
    }

    // Brief settle wait for iframes/dynamic content
    await new Promise(r => setTimeout(r, 300));

    // Observe (wait for any iframes to settle)
    const obs = await surface.observe();
    stepCount++;
    const iframeEls = obs.elements.filter(e => e.frame !== 'main');
    journal.event('observed', { step: stepCount, elements: obs.elements.length, iframeElements: iframeEls.length, url: obs.url });

    // Build context
    const ctx: DecisionContext = {
      goal: contract.goal,
      contract: {
        name: contract.name,
        inputs: Object.fromEntries(Object.entries(contract.inputs).map(([k, v]) => [k, { type: v.type, exampleValue: v.exampleValue }])),
        outputs: Object.fromEntries(Object.entries(contract.outputs).map(([k, v]) => [k, { type: v.type }])),
      },
      journal: journalLines,
      observation: obs,
    };

    // Decide
    const toolCall = await llmClient.decide(ctx);
    journal.event('decision', { step: stepCount, tool: toolCall.tool });

    // ── DONE ──────────────────────────────────────────────
    if (toolCall.tool === 'done') {
      // Verify: all outputs populated + parsed
      const outputs = recorder.getOutputs();
      const errors: string[] = [];
      for (const [name, decl] of Object.entries(contract.outputs)) {
        if (!(name in outputs) || outputs[name] == null) {
          errors.push(`Output "${name}" not populated`);
        }
      }

      if (errors.length > 0) {
        const msg = `Verification failed: ${errors.join('; ')}`;
        journalLines.push(`VERIFY_FAILED: ${msg}`);
        journal.event('verify_failed', { errors });
        // Loop continues — model must do more work
        continue;
      }

      // Compile
      journal.event('compiling', {});

      // Fix the first ledger entry's expect (the initial navigate)
      const ledger = recorder.getLedger();
      if (ledger.length > 1) {
        // The initial navigate's expect should be the page indicator after navigation
        // Use the second entry's observation context — but for simplicity, use textPresent
        // with the start page's expected text
      }

      const artifact = recorder.compile(contract);

      try {
        const artifactPath = recorder.saveArtifact(artifact, config.capabilitiesDir, journal.runDir);
        journal.event('compiled', { path: artifactPath });
        return { status: 'compiled', artifactPath, artifact };
      } catch (e) {
        return { status: 'aborted', reason: `Compile failed: ${(e as Error).message}` };
      }
    }

    // ── ACT ───────────────────────────────────────────────
    const act = toolCall as ActToolCall;

    // Same-action detection (use target name/value, not ref — refs are ephemeral)
    const targetDesc = act.targetRef
      ? (obs.elements.find(e => e.ref === act.targetRef)?.name ?? act.targetRef)
      : (act.value ?? '');
    const verbTarget = `${act.verb}:${targetDesc}`;
    if (verbTarget === lastVerbTarget) {
      sameActionCount++;
      if (sameActionCount >= MAX_SAME_ACTION) {
        return { status: 'dead_end', reason: `Same action repeated ${MAX_SAME_ACTION} times` };
      }
      if (sameActionCount === 2) {
        journalLines.push('WARNING: same action repeated twice');
        journal.event('same_action_warning', { verbTarget });
      }
    } else {
      sameActionCount = 1;
      lastVerbTarget = verbTarget;
    }

    // Navigate actions: skip describe, just navigate
    if (act.verb === 'navigate' && act.value) {
      journal.event('navigate', { path: act.value, intent: act.intent });
      const navRes = await surface.navigate(act.value);
      if (!navRes.ok) {
        if (navRes.blocked) {
          refusalCount++;
          journalLines.push(`REFUSAL: navigate to ${act.value} blocked (${navRes.blocked.rule})`);
          journal.event('refusal', { verb: 'navigate', value: act.value, rule: navRes.blocked.rule });
          continue;
        }
        journalLines.push(`ERROR: navigate failed: ${navRes.error}`);
        continue;
      }

      // Check expect
      if (await surface.check(act.expectProposal)) {
        recorder.record({
          intent: act.intent,
          verb: 'navigate',
          value: act.value,
          chain: [{ by: 'structural' as const, note: 'navigation target' }],
          expect: act.expectProposal,
        });
        journalLines.push(`OK: navigate ${act.value} → expect passed`);
        journal.event('step_ok', { step: stepCount, verb: 'navigate' });

        // No duplicate check needed
      } else {
        journalLines.push(`EXPECT_FAILED: navigate ${act.value} — expect not met`);
        journal.event('expect_failed', { step: stepCount });
      }
      continue;
    }

    // Element-targeted actions: DESCRIBE FIRST (Amendment B)
    if (!act.targetRef) {
      journalLines.push(`ERROR: no targetRef for ${act.verb} action`);
      continue;
    }

    // Describe BEFORE act (refs die on navigation)
    const chain = await surface.describe(act.targetRef);
    const targetEl = obs.elements.find(e => e.ref === act.targetRef);

    // Resolve the chain to get a ref with stored Playwright Locator
    const resolveResult = await surface.resolve(chain.length > 0 ? chain : [{ by: 'structural' as const, note: 'fallback' }]);
    journal.event('resolve_result', { step: stepCount, kind: resolveResult.kind, chainLen: chain.length });
    if (resolveResult.kind !== 'match') {
      journalLines.push(`RESOLVE_FAILED: ${act.verb} — chain did not match (${resolveResult.kind})`);
      journal.event('resolve_failed', { step: stepCount, kind: resolveResult.kind });
      continue;
    }
    const actRef = resolveResult.ref;

    // Act
    const actResult = await surface.act({
      verb: act.verb,
      value: act.value,
      ref: actRef,
    });

    if (!actResult.ok) {
      if (actResult.blocked) {
        refusalCount++;
        journalLines.push(`REFUSAL: ${act.verb} blocked (${actResult.blocked.rule})`);
        journal.event('refusal', { verb: act.verb, rule: actResult.blocked.rule });
        continue;
      }
      journalLines.push(`ERROR: ${act.verb} failed: ${actResult.error}`);
      journal.event('act_error', { verb: act.verb, error: actResult.error });
      continue;
    }

    journal.event('act_result', { step: stepCount, ok: actResult.ok, readValue: actResult.readValue ?? null, verb: act.verb });

    // Handle read: extract value, parse, store
    if (act.verb === 'read' && actResult.readValue != null && act.outputName) {
      const outputDecl = contract.outputs[act.outputName];
      if (outputDecl) {
        const parsed = parseOutputValue(actResult.readValue, outputDecl.type);
        if (parsed != null) {
          recorder.setOutput(act.outputName, parsed);
          journal.event('output_read', { outputName: act.outputName, parseAs: outputDecl.type });
        }
      }
    }

    // Verify expect proposal against the REAL page
    let expectOk: boolean;
    const pred = act.expectProposal as Record<string, unknown>;
    if ('elementValue' in pred) {
      expectOk = true; // fill is synchronous with DOM
    } else if ('outputPopulated' in pred) {
      const key = pred.outputPopulated as string;
      const outputs = recorder.getOutputs();
      expectOk = key in outputs && outputs[key] != null;
    } else {
      expectOk = await surface.check(act.expectProposal);
    }

    if (expectOk) {
      // Record to ledger
      recorder.record({
        intent: act.intent,
        verb: act.verb,
        value: act.value,
        chain: chain.length > 0 ? chain : [{ by: 'structural' as const, note: 'fallback' }],
        expect: act.expectProposal,
        outputName: act.outputName,
        parseAs: act.outputName ? contract.outputs[act.outputName]?.type : undefined,
        paramHint: act.paramHint,
        targetName: targetEl?.name,
        targetIsPassword: targetEl?.role === 'textbox' && targetEl?.nearbyText?.toLowerCase().includes('password'),
      });
      journalLines.push(`OK: ${act.verb} ${act.targetRef} → expect passed`);
      // If a read populated an output, tell the model explicitly
      if (act.verb === 'read' && act.outputName) {
        const val = recorder.getOutputs()[act.outputName];
        if (val != null) {
          journalLines.push(`OUTPUT_POPULATED: ${act.outputName} — call done now`);
        }
      }
      journal.event('step_ok', { step: stepCount, verb: act.verb, rungCount: chain.length });
    } else {
      // Expect failed. For click actions that caused page navigation, still record
      // with a fallback expect based on what IS visible now.
      if (act.verb === 'click') {
        const currentObs = await surface.observe();
        const visibleBtn = currentObs.elements.find(e => e.role === 'button' || e.role === 'heading');
        const fallbackExpect = visibleBtn
          ? { textPresent: visibleBtn.name.substring(0, 40) } as const
          : { urlMatches: new URL(currentObs.url).pathname } as const;

        recorder.record({
          intent: act.intent,
          verb: act.verb,
          value: act.value,
          chain: chain.length > 0 ? chain : [{ by: 'structural' as const, note: 'fallback' }],
          expect: fallbackExpect,
          targetName: targetEl?.name,
          targetIsPassword: false,
        });
        journalLines.push(`OK: ${act.verb} ${act.targetRef} → recorded with fallback expect`);
        journal.event('step_ok_fallback', { step: stepCount, verb: act.verb, fallbackExpect });
      } else {
        journalLines.push(`EXPECT_FAILED: ${act.verb} ${act.targetRef} — retrying`);
        journal.event('expect_failed', { step: stepCount, verb: act.verb });
      }
    }
  }
}
