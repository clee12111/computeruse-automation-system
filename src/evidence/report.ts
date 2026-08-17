// src/evidence/report.ts — Run report generator.
// Pure function: journal events + artifact + result → report object + markdown.
// Deterministic, no LLM, no I/O. Covers all 4 cases.
// Sensitive values must already be redacted in the journal input.

// ── Types ──────────────────────────────────────────────────

export interface RunReport {
  type: 'discovery_success' | 'discovery_failure' | 'replay_success' | 'replay_failure';
  header: {
    capability: string;
    version?: string;
    app?: string;
    site?: string;
    timestamp: string;
    durationMs?: number;
    caller?: string;
  };
  contract?: {
    goal?: string;
    inputs: Record<string, { type: string; pattern?: string; sensitive: boolean }>;
    outputs: Record<string, { type: string; sensitive: boolean }>;
    businessOutcomes?: string[];
  };
  result?: {
    status: string;
    outputs?: Record<string, unknown>;
    outcome?: string;
    reason?: string;
  };
  steps: ReportStep[];
  warnings: string[];
  costSummary?: { turns: number; totalTokens: number; promptTokens: number; completionTokens: number; wallClockMs: number };
  provenance?: { model?: string; humanAssisted: boolean; humanActions?: string[] };
  trustState?: { status: string; approvedBy?: string };
  driftSignals?: string[];
  reviewChecklist?: string[];
  nextActions: string[];
  candidateTables?: ReportCandidateTable[];
  diagnosis?: string;
  collapsedSteps?: CollapsedStepGroup[];
  lastObservation?: { stepNumber: number; url: string; pageContext: string; stillNeeded: string };
}

export interface ReportStep {
  number: number;
  id: string;
  intent: string;
  action: string;
  target: string;
  identification: string;
  proof: string;
  risk: string;
  result: 'passed' | 'failed' | 'skipped' | 'recovered';
  margin?: number;
  timing?: string;
  issues?: string[];
}

export interface ReportCandidateTable {
  stepId: string;
  stepIntent: string;
  candidates: Array<{
    rank: number;
    score: number;
    breakdown: Record<string, number>;
    matchSummary: string;
  }>;
}

interface CollapsedStepGroup {
  startStep: number;
  endStep: number;
  count: number;
  summary: string;
  result: ReportStep['result'];
}

// ── Helpers: human-readable descriptions ───────────────────

function describeAction(step: any): string {
  if (!step?.action) return '(unknown action)';
  const v = step.action.verb;
  const val = step.action.value;

  if (v === 'navigate') return `Navigate to \`${val}\``;
  if (v === 'click') return `Click "${step.target?.properties?.name || 'element'}"`;
  if (v === 'type') {
    const what = val && typeof val === 'object' && val.$input
      ? `{${val.$input}}`
      : `"${val || ''}"`;
    const where = step.target?.properties?.name
      || step.target?.properties?.neighborText?.[0]
      || step.target?.properties?.attrName
      || 'a field';
    return `Type ${what} into "${where}"`;
  }
  if (v === 'select') return `Select "${val}" from dropdown`;
  if (v === 'read') {
    const col = step.target?.properties?.columnHeader;
    const saveTo = step.action.saveTo || 'output';
    return `Read the value${col ? ` in the "${col}" column` : ''} and save as \`${saveTo}\``;
  }
  return `${v}${val ? ` "${val}"` : ''}`;
}

function describeTarget(props: any): string {
  if (!props) return '(no target)';
  const parts: string[] = [];
  parts.push(props.role || 'element');
  if (props.name) parts.push(`named "${props.name}"`);
  if (props.attrName) parts.push(`(HTML name: ${props.attrName})`);
  if (props.columnHeader) parts.push(`in column "${props.columnHeader}"`);
  if (props.neighborText?.length) parts.push(`near text [${props.neighborText.join(', ')}]`);
  parts.push(`in ${props.frame || 'main'} frame`);
  return parts.join(' ');
}

function describeExpect(expect: any): string {
  if (!expect) return '(no checkpoint)';
  if (expect.textPresent) return `the page must show the text '${expect.textPresent}'`;
  if (expect.textAbsent) return `the page must NOT show the text '${expect.textAbsent}'`;
  if (expect.urlMatches) return `the URL must match \`${expect.urlMatches}\``;
  if (expect.elementPresent) return `the element '${expect.elementPresent}' must exist`;
  if (expect.outputPopulated) return `output \`${expect.outputPopulated}\` must have a value`;
  if (expect.elementValue) return 'the field must contain the typed value';
  if (expect.anyOf) return expect.anyOf.map((e: any) => describeExpect(e)).join(' OR ');
  if (expect.allOf) return expect.allOf.map((e: any) => describeExpect(e)).join(' AND ');
  if (expect.$outcome) return `business outcome: ${expect.$outcome}`;
  // No raw JSON in prose — humanize the keys
  const keys = Object.keys(expect);
  if (keys.length > 0) {
    const parts = keys.map(k => `${k} = ${JSON.stringify(expect[k])}`);
    return parts.join(', ');
  }
  return '(unknown checkpoint)';
}

function describeIdentification(props: any): string {
  if (!props) return 'No target properties recorded.';
  const idents: string[] = [];
  const robust: string[] = [];
  const fragile: string[] = [];

  if (props.name) { idents.push(`accessible name "${props.name}"`); robust.push('accessible name (survives layout changes)'); }
  if (props.attrName) { idents.push(`HTML name "${props.attrName}"`); robust.push('HTML name attr (stable across reflows)'); }
  if (props.columnHeader) { idents.push(`column header "${props.columnHeader}"`); robust.push('column header (structural)'); }
  if (props.neighborText?.length) { idents.push(`neighbor text [${props.neighborText.join(', ')}]`); robust.push('neighbor text context'); }
  if (props.frame && props.frame !== 'main') robust.push(`scoped to frame "${props.frame}"`);
  if (props.position) fragile.push('position (breaks on layout change)');
  if (!props.name && !props.attrName && !props.columnHeader) fragile.push('no semantic identifier — fragile');

  let out = idents.length ? `Identified by ${idents.join(' + ')}.` : `Identified by role "${props.role}" and position only.`;
  if (robust.length) out += ` Robust: ${robust.join('; ')}.`;
  if (fragile.length) out += ` Fragile: ${fragile.join('; ')}.`;
  return out;
}

// ── Diagnosis computation (discovery failure) ──────────────

function computeDiagnosis(events: any[], contract: any): string {
  const patterns: string[] = [];

  // Pattern: called done N consecutive times without populating output X
  const decisions = events.filter(e => e.event === 'decision');
  const verifyFailures = events.filter(e => e.event === 'verify_failed');
  if (verifyFailures.length > 0) {
    // Count consecutive done calls
    let consecutiveDone = 0;
    for (let i = decisions.length - 1; i >= 0; i--) {
      if (decisions[i].tool === 'done') consecutiveDone++;
      else break;
    }
    if (consecutiveDone > 1) {
      const lastFail = verifyFailures[verifyFailures.length - 1];
      const missing = lastFail.errors?.join(', ') || 'unknown outputs';
      patterns.push(`called done ${consecutiveDone} consecutive times without populating: ${missing}`);
    }
  }

  // Pattern: never navigated past a URL
  const observed = events.filter(e => e.event === 'observed');
  const urls = observed.map(o => o.url).filter(Boolean);
  const uniqueUrls = [...new Set(urls)];
  if (uniqueUrls.length === 1 && observed.length > 2) {
    patterns.push(`never navigated past ${uniqueUrls[0]}`);
  }

  // Pattern: same_action_warning fired N times
  const sameActionWarnings = events.filter(e => e.event === 'same_action_warning');
  if (sameActionWarnings.length > 0) {
    const targets = sameActionWarnings.map(w => w.verbTarget);
    const counts: Record<string, number> = {};
    for (const t of targets) counts[t] = (counts[t] || 0) + 1;
    for (const [target, count] of Object.entries(counts)) {
      patterns.push(`same_action_warning fired ${count} time${count > 1 ? 's' : ''} on ${target}`);
    }
  }

  // Pattern: repeated expect failures
  const expectFailures = events.filter(e => e.event === 'expect_failed');
  if (expectFailures.length >= 3) {
    patterns.push(`expect check failed ${expectFailures.length} times`);
  }

  // Pattern: refusals
  const refusals = events.filter(e => e.event === 'refusal');
  if (refusals.length > 0) {
    const rules = [...new Set(refusals.map(r => r.rule))];
    patterns.push(`blocked by policy ${refusals.length} time${refusals.length > 1 ? 's' : ''} (rules: ${rules.join(', ')})`);
  }

  // Pattern: dead end reason
  const deadEnd = events.find(e => e.event === 'dead_end');
  if (deadEnd) {
    patterns.push(`stop condition: ${deadEnd.reason}`);
  }

  if (patterns.length === 0) return 'no pattern detected';
  return patterns.join('; ');
}

// ── Collapse consecutive identical steps ───────────────────

function collapseConsecutiveSteps(steps: ReportStep[]): CollapsedStepGroup[] {
  if (steps.length === 0) return [];

  const groups: CollapsedStepGroup[] = [];
  let i = 0;

  while (i < steps.length) {
    const current = steps[i];
    // Look ahead for identical action + intent + result
    let j = i + 1;
    while (j < steps.length
      && steps[j].action === current.action
      && steps[j].intent === current.intent
      && steps[j].result === current.result) {
      j++;
    }

    const count = j - i;
    if (count >= 3) {
      // Collapse: 3+ identical steps
      groups.push({
        startStep: current.number,
        endStep: steps[j - 1].number,
        count,
        summary: `${current.action}${current.intent !== current.action ? ` — "${current.intent}"` : ''}`,
        result: current.result,
      });
    } else {
      // Keep individual steps as single-item groups
      for (let k = i; k < j; k++) {
        groups.push({
          startStep: steps[k].number,
          endStep: steps[k].number,
          count: 1,
          summary: steps[k].action,
          result: steps[k].result,
        });
      }
    }
    i = j;
  }

  return groups;
}

// ── Parse candidates from observed string ──────────────────

function parseCandidatesFromObserved(observed: string): Array<{
  rank: number;
  score: number;
  breakdown: Record<string, number>;
  matchSummary: string;
}> {
  // Format: "rung 0 (textbox): score=6.25 margin=0.000; rung 1 (textbox): score=6.25 margin=0.000"
  const candidates: Array<{
    rank: number;
    score: number;
    breakdown: Record<string, number>;
    matchSummary: string;
  }> = [];

  const rungPattern = /rung\s+(\d+)\s+\(([^)]+)\):\s+score=([\d.]+)\s+margin=([\d.]+)/g;
  let match: RegExpExecArray | null;
  let rank = 1;

  while ((match = rungPattern.exec(observed)) !== null) {
    const role = match[2];
    const score = parseFloat(match[3]);
    const margin = parseFloat(match[4]);
    candidates.push({
      rank: rank++,
      score,
      breakdown: { score, margin },
      matchSummary: `${role}: score ${score.toFixed(2)}, margin ${margin.toFixed(3)}`,
    });
  }

  return candidates;
}

// ── Describe what properties matched (not "1 properties matched") ──

function describeMatchedProperties(breakdown: Record<string, number>): string {
  const matched: string[] = [];
  const missed: string[] = [];
  for (const [key, value] of Object.entries(breakdown)) {
    if (key === 'score' || key === 'margin') continue;
    if (Number(value) >= 0.8) matched.push(key);
    else if (Number(value) >= 0.5) matched.push(`${key} (partial)`);
    else missed.push(key);
  }
  if (matched.length === 0 && missed.length === 0) return '(no property details)';
  const parts: string[] = [];
  if (matched.length) parts.push(`matched: ${matched.join(', ')}`);
  if (missed.length) parts.push(`missed: ${missed.join(', ')}`);
  return parts.join('; ');
}

// ── Main generator ─────────────────────────────────────────

export function generateReport(
  events: any[],
  artifact: any | null,
  result: any | null,
): RunReport {

  const isDiscovery = events.some(e => e.event === 'discovery_start');
  const compiled = events.find(e => e.event === 'compiled');
  const deadEnd = events.find(e => e.event === 'dead_end');
  const aborted = events.find(e => e.event === 'aborted');
  const tokenSummary = events.find(e => e.event === 'token_summary');
  const discoveryStart = events.find(e => e.event === 'discovery_start');

  const isSuccess = isDiscovery
    ? !!compiled
    : (result?.status === 'SUCCESS' || result?.status === 'BUSINESS_OUTCOME');

  const type: RunReport['type'] = isDiscovery
    ? (isSuccess ? 'discovery_success' : 'discovery_failure')
    : (isSuccess ? 'replay_success' : 'replay_failure');

  // Timestamps
  const firstTs = events[0]?.timestamp || '';
  const lastTs = events[events.length - 1]?.timestamp || '';
  const durationMs = firstTs && lastTs
    ? new Date(lastTs).getTime() - new Date(firstTs).getTime()
    : undefined;

  const header: RunReport['header'] = {
    capability: discoveryStart?.name || artifact?.name || '(unknown)',
    version: artifact?.version,
    app: artifact?.app?.id,
    timestamp: firstTs,
    durationMs,
  };

  // Contract
  let contract: RunReport['contract'] | undefined;
  if (artifact) {
    contract = {
      goal: discoveryStart?.goal,
      inputs: artifact.inputs || {},
      outputs: artifact.outputs || {},
      businessOutcomes: Object.keys(artifact.businessOutcomes || {}),
    };
  } else if (discoveryStart) {
    contract = { goal: discoveryStart.goal, inputs: {}, outputs: {} };
  }

  // Result
  let reportResult: RunReport['result'] | undefined;
  if (result) {
    reportResult = {
      status: result.status,
      outputs: result.outputs,
      outcome: result.code,
      reason: result.reason || result.observed,
    };
  } else if (deadEnd) {
    reportResult = { status: 'DEAD_END', reason: deadEnd.reason };
  } else if (aborted) {
    reportResult = { status: 'ABORTED', reason: aborted.reason };
  } else if (compiled) {
    reportResult = { status: 'COMPILED' };
  }

  // ── Steps ────────────────────────────────────────────────
  const steps: ReportStep[] = [];
  const warnings: string[] = [];

  if (isDiscovery && type === 'discovery_success' && artifact?.steps?.length) {
    // Compiled discovery: use the artifact steps (the authoritative record)
    const journalIssues = new Map<number, string[]>();
    const observedEvs = events.filter(e => e.event === 'observed');
    for (let i = 0; i < observedEvs.length; i++) {
      const obs = observedEvs[i];
      const obsIdx = events.indexOf(obs);
      const nextIdx = i + 1 < observedEvs.length ? events.indexOf(observedEvs[i + 1]) : events.length;
      const stepEvs = events.slice(obsIdx, nextIdx);
      const iss: string[] = [];
      const warn = stepEvs.find(e => e.event === 'same_action_warning');
      const refused = stepEvs.find(e => e.event === 'refusal');
      const expectFail = stepEvs.find(e => e.event === 'expect_failed');
      if (warn) iss.push(`Repeated action: ${warn.verbTarget}`);
      if (refused) iss.push(`Blocked by policy: ${refused.rule}`);
      if (expectFail) iss.push('Expected page state not reached');
      if (iss.length) journalIssues.set(obs.step, iss);
    }

    for (let i = 0; i < artifact.steps.length; i++) {
      const artStep = artifact.steps[i];
      steps.push({
        number: i + 1,
        id: artStep.id,
        intent: artStep.intent || describeAction(artStep),
        action: describeAction(artStep),
        target: describeTarget(artStep.target?.properties),
        identification: describeIdentification(artStep.target?.properties),
        proof: describeExpect(artStep.expect),
        risk: artStep.risk === 'risky' ? 'risky — irreversible action' : 'safe',
        result: 'passed',
        issues: journalIssues.get(i + 1),
      });
    }
  } else if (isDiscovery) {
    // Failed discovery: use journal events (no artifact)
    // Filter out 'done' calls — they are not real steps
    const observedEvs = events.filter(e => e.event === 'observed');
    for (let i = 0; i < observedEvs.length; i++) {
      const obs = observedEvs[i];
      const obsIdx = events.indexOf(obs);
      const nextIdx = i + 1 < observedEvs.length ? events.indexOf(observedEvs[i + 1]) : events.length;
      const stepEvs = events.slice(obsIdx, nextIdx);

      const decision = stepEvs.find(e => e.event === 'decision');

      // Skip done calls — they are not real steps
      if (decision?.tool === 'done') continue;

      const acted = stepEvs.find(e => e.event === 'step_ok' || e.event === 'step_ok_fallback');
      const actResult = stepEvs.find(e => e.event === 'act_result');
      const nav = stepEvs.find(e => e.event === 'navigate');
      const warn = stepEvs.find(e => e.event === 'same_action_warning');
      const refused = stepEvs.find(e => e.event === 'refusal');
      const resolveFail = stepEvs.find(e => e.event === 'resolve_failed');
      const expectFail = stepEvs.find(e => e.event === 'expect_failed');
      const actError = stepEvs.find(e => e.event === 'act_error');

      const issues: string[] = [];
      if (warn) issues.push(`Repeated action: ${warn.verbTarget}`);
      if (refused) issues.push(`Blocked by policy: ${refused.rule}`);
      if (resolveFail) issues.push(`Element not found (${resolveFail.kind})`);
      if (actError) issues.push(`Action error: ${actError.error}`);
      if (expectFail) issues.push('Expected page state not reached');

      const verb = decision?.verb || actResult?.verb || nav?.verb || acted?.verb || 'act';
      const targetName = decision?.targetName || '';
      const intent = decision?.intent || nav?.intent || '';

      const stepResult: ReportStep['result'] = refused || resolveFail || actError
        ? 'failed' : acted ? 'passed' : expectFail ? 'failed' : 'skipped';

      const pageContext: string[] = [];
      if (obs.headings?.length) pageContext.push(`headings: ${obs.headings.join(', ')}`);
      if (obs.fields?.length) pageContext.push(`fields: ${obs.fields.join(', ')}`);
      if (obs.buttons?.length) pageContext.push(`buttons: ${obs.buttons.slice(0, 5).join(', ')}`);

      steps.push({
        number: obs.step,
        id: `step-${obs.step}`,
        intent: intent || `${verb}${targetName ? ` on "${targetName}"` : ''}`,
        action: nav ? `Navigate to \`${nav.path}\``
          : `${verb}${targetName ? ` on "${targetName}"` : ''}${decision?.value ? ` value="${decision.value}"` : ''}`,
        target: targetName
          ? `${decision?.targetRole || 'element'} named "${targetName}" at ${obs.url}`
          : `(LLM-selected at ${obs.url})`,
        identification: pageContext.length
          ? `Page had ${obs.elements} elements. ${pageContext.join('; ')}.`
          : `Page had ${obs.elements} elements.`,
        proof: acted?.fallbackExpect ? describeExpect(acted.fallbackExpect) : '(LLM-proposed)',
        risk: 'safe',
        result: stepResult,
        timing: obs.timestamp,
        issues: issues.length ? issues : undefined,
      });
    }
  } else {
    // Replay: group by step_start
    const stepStarts = events.filter(e => e.event === 'step_start');
    const stepEvents: Record<string, any[]> = {};
    let currentStep = '';
    for (const ev of events) {
      if (ev.event === 'step_start') {
        currentStep = ev.stepId;
        // Append, don't replace — a step may restart after recovery
        if (!stepEvents[currentStep]) stepEvents[currentStep] = [];
      }
      if (currentStep && stepEvents[currentStep]) stepEvents[currentStep].push(ev);
    }
    const artSteps = artifact?.steps || [];

    // Deduplicate step_starts (a step may restart after recovery)
    const seenStepIds = new Set<string>();
    const uniqueStarts = stepStarts.filter(ss => {
      if (seenStepIds.has(ss.stepId)) return false;
      seenStepIds.add(ss.stepId);
      return true;
    });

    for (let i = 0; i < uniqueStarts.length; i++) {
      const ss = uniqueStarts[i];
      const evs = stepEvents[ss.stepId] || [];
      const artStep = artSteps.find((s: any) => s.id === ss.stepId);

      const scoring = evs.find(e => e.event === 'scoring_result');
      const expectPassed = evs.find(e => e.event === 'expect_passed');
      const outcomeDetected = evs.find(e => e.event === 'outcome_detected');
      const recovery = evs.find(e => e.event === 'recovery_complete');
      const lowMargin = evs.find(e => e.event === 'low_margin_warning');
      const errorDetected = evs.find(e => e.event === 'error_detected');

      const issues: string[] = [];
      if (lowMargin) issues.push(`Low margin: ${lowMargin.margin?.toFixed(3)} — close call, will break first if site changes`);
      if (errorDetected && recovery) {
        // Build the full recovery narrative with substeps
        const recovSteps = evs.filter(e => e.event === 'recovery_step');
        const substepDescs = recovSteps.map(rs => `${rs.stepId}: ${rs.intent || rs.verb}`);
        issues.push(`Error "${errorDetected.error}" detected at this step. The system ran ${recovSteps.length} recovery substeps: ${substepDescs.join(' → ')}. Recovery succeeded — the step was retried and passed.`);
      } else if (errorDetected) {
        issues.push(`Error detected mid-flow: ${errorDetected.error}`);
      }

      const stepResult: ReportStep['result'] = recovery ? 'recovered'
        : (expectPassed || outcomeDetected) ? 'passed'
        : (result?.stepId === ss.stepId && result?.status === 'HARD_FAILURE') ? 'failed'
        : 'passed';

      steps.push({
        number: i + 1,
        id: ss.stepId,
        intent: ss.intent || artStep?.intent || '(no intent)',
        action: artStep ? describeAction(artStep) : '(unknown)',
        target: artStep ? describeTarget(artStep.target?.properties) : '(unknown)',
        identification: artStep ? describeIdentification(artStep.target?.properties) : '(no target data)',
        proof: artStep ? describeExpect(artStep.expect) : '(unknown)',
        risk: artStep?.risk === 'risky' ? 'risky — irreversible action' : 'safe',
        result: stepResult,
        margin: scoring?.margin,
        timing: ss.timestamp,
        issues: issues.length ? issues : undefined,
      });
    }
  }

  // Cost
  let costSummary: RunReport['costSummary'] | undefined;
  if (tokenSummary) {
    const turns = events.filter(e => e.event === 'decision').length;
    costSummary = {
      turns,
      totalTokens: tokenSummary.totalTokens || 0,
      promptTokens: tokenSummary.promptTokens || 0,
      completionTokens: tokenSummary.completionTokens || 0,
      wallClockMs: durationMs || 0,
    };
  }

  // Provenance
  const humanTransfers = events.filter(e => e.event === 'control_transfer' && e.to === 'human');
  const humanActionEvs = events.filter(e => e.event === 'human_actions');
  const provenance: RunReport['provenance'] = {
    model: tokenSummary ? 'OpenAI' : undefined,
    humanAssisted: humanTransfers.length > 0,
    humanActions: humanActionEvs.map(h => h.summary || 'intervention recorded'),
  };

  // Drift signals (replay)
  const driftSignals: string[] = [];
  if (!isDiscovery) {
    for (const ev of events.filter(e => e.event === 'low_margin_warning')) {
      const artStep = artifact?.steps?.find((s: any) => s.id === ev.stepId);
      driftSignals.push(
        `Step "${ev.stepId}"${artStep ? ` (${artStep.intent})` : ''}: margin ${ev.margin?.toFixed(3)} — will break first if the site changes.`,
      );
    }
  }

  // Review checklist (discovery success) — computed, specific
  let reviewChecklist: string[] | undefined;
  if (type === 'discovery_success' && artifact) {
    reviewChecklist = [];

    // Fallback expects (step_ok_fallback events in journal)
    const fallbackEvents = events.filter(e => e.event === 'step_ok_fallback');
    for (const fb of fallbackEvents) {
      const expectDesc = fb.fallbackExpect ? describeExpect(fb.fallbackExpect) : 'unknown';
      reviewChecklist.push(`Step ${fb.step}: used fallback checkpoint (${expectDesc}) — the original expect failed. Verify this is reliable.`);
    }

    // Short/generic expect text (<= 3 chars)
    for (const step of artifact.steps || []) {
      if (step.expect?.textPresent && step.expect.textPresent.length <= 3) {
        reviewChecklist.push(`Step "${step.id}" expects text '${step.expect.textPresent}' — only ${step.expect.textPresent.length} chars, may match unrelated pages.`);
      }
    }

    // Steps where action didn't complete (no act_result but page changed)
    const observedEvs = events.filter(e => e.event === 'observed');
    for (let i = 0; i < observedEvs.length; i++) {
      const obs = observedEvs[i];
      const obsIdx = events.indexOf(obs);
      const nextIdx = i + 1 < observedEvs.length ? events.indexOf(observedEvs[i + 1]) : events.length;
      const stepEvs = events.slice(obsIdx, nextIdx);
      const hasActResult = stepEvs.some(e => e.event === 'act_result');
      const nextObs = observedEvs[i + 1];
      if (!hasActResult && nextObs && nextObs.url !== obs.url) {
        reviewChecklist.push(`Step ${obs.step}: no action result recorded but page changed (${obs.url} -> ${nextObs.url}). Verify step completed.`);
      }
    }

    // Risky steps
    for (const step of artifact.steps || []) {
      if (step.risk === 'risky') {
        reviewChecklist.push(`Step "${step.id}" is RISKY (${step.intent}) — verify this action is safe to automate.`);
      }
    }

    // Repeated actions (same_action_warning)
    const sameActionWarnings = events.filter(e => e.event === 'same_action_warning');
    for (const w of sameActionWarnings) {
      reviewChecklist.push(`Repeated action warning: ${w.verbTarget}. The model struggled here — check if the step is correct.`);
    }

    // verify_failed before success
    const verifyFailures = events.filter(e => e.event === 'verify_failed');
    if (verifyFailures.length > 0) {
      reviewChecklist.push(`Output verification failed ${verifyFailures.length} time${verifyFailures.length > 1 ? 's' : ''} before success. The model needed multiple attempts to populate outputs.`);
    }

    // Steps with no semantic identifier
    for (const step of artifact.steps || []) {
      const props = step.target?.properties;
      if (props && !props.name && !props.attrName && !props.columnHeader) {
        reviewChecklist.push(`Step "${step.id}" has no semantic identifier — relies on position only. Fragile.`);
      }
    }

    // Unused inputs, unreached outputs
    const referencedInputs = new Set<string>();
    const populatedOutputs = new Set<string>();
    for (const step of artifact.steps || []) {
      const val = step.action?.value;
      if (val && typeof val === 'object' && val.$input) referencedInputs.add(val.$input);
      if (step.action?.verb === 'read' && step.action?.saveTo) populatedOutputs.add(step.action.saveTo);
    }
    for (const [k, v] of Object.entries(artifact.inputs || {}) as [string, any][]) {
      if (!v.sensitive && !referencedInputs.has(k)) reviewChecklist.push(`Input "${k}" declared but never used in any step.`);
    }
    for (const k of Object.keys(artifact.outputs || {})) {
      if (!populatedOutputs.has(k)) reviewChecklist.push(`Output "${k}" declared but no step reads it.`);
    }

    if (reviewChecklist.length === 0) reviewChecklist.push('All steps have semantic identifiers. All inputs/outputs are wired. No risky steps. No warnings.');
  }

  // Candidate tables (replay failure)
  let candidateTables: ReportCandidateTable[] | undefined;
  if (type === 'replay_failure') {
    const scoringEvs = events.filter(e => e.event === 'scoring_result' && e.candidates?.length);
    if (scoringEvs.length > 0) {
      candidateTables = scoringEvs.map(se => {
        const artStep = artifact?.steps?.find((s: any) => s.id === se.stepId);
        return {
          stepId: se.stepId,
          stepIntent: artStep?.intent || se.stepId,
          candidates: (se.candidates || []).map((c: any, j: number) => {
            const bd = c.breakdown || {};
            const matchDesc = describeMatchedProperties(bd);
            return { rank: j + 1, score: c.score, breakdown: bd, matchSummary: matchDesc };
          }),
        };
      });
    } else if (result?.observed) {
      // Try parsing candidates from result.observed string
      const parsed = parseCandidatesFromObserved(result.observed);
      if (parsed.length > 0) {
        const failStepId = result.stepId || steps.find(s => s.result === 'failed')?.id || 'unknown';
        const artStep = artifact?.steps?.find((s: any) => s.id === failStepId);
        candidateTables = [{
          stepId: failStepId,
          stepIntent: artStep?.intent || failStepId,
          candidates: parsed,
        }];
      }
    }
  }

  // Diagnosis (discovery failure)
  let diagnosis: string | undefined;
  let collapsedSteps: CollapsedStepGroup[] | undefined;
  let lastObservation: RunReport['lastObservation'] | undefined;

  if (type === 'discovery_failure') {
    diagnosis = computeDiagnosis(events, contract);
    collapsedSteps = collapseConsecutiveSteps(steps);

    // Compute last observation
    const lastObs = [...events].reverse().find(e => e.event === 'observed');
    if (lastObs) {
      const pageCtx: string[] = [];
      if (lastObs.headings?.length) pageCtx.push(`headings: ${lastObs.headings.join(', ')}`);
      if (lastObs.fields?.length) pageCtx.push(`fields: ${lastObs.fields.join(', ')}`);
      if (lastObs.buttons?.length) pageCtx.push(`buttons: ${lastObs.buttons.slice(0, 5).join(', ')}`);

      // Determine what was still needed
      const stillNeeded: string[] = [];
      if (contract?.outputs) {
        for (const k of Object.keys(contract.outputs)) {
          stillNeeded.push(`output "${k}"`);
        }
      }

      lastObservation = {
        stepNumber: lastObs.step,
        url: lastObs.url || '(unknown)',
        pageContext: pageCtx.length ? pageCtx.join('; ') : `${lastObs.elements} elements on page`,
        stillNeeded: stillNeeded.length ? stillNeeded.join(', ') : 'unknown',
      };
    }
  }

  // Next actions
  const nextActions: string[] = [];
  if (type === 'discovery_success') {
    nextActions.push('Review the script walkthrough and checklist above.');
    nextActions.push(`Approve: \`npm run cli -- approve ${header.capability} --version ${artifact?.version || '1.0.0'}\``);
    nextActions.push('Until approved, this capability cannot be called by agents.');
  } else if (type === 'discovery_failure') {
    // Ranked by likelihood of helping
    const reason = deadEnd?.reason || aborted?.reason || '';
    if (reason.includes('Same action')) {
      nextActions.push('1. The agent got stuck in a loop — rephrase the goal to be more specific about what to click/fill.');
    }
    if (reason.includes('Max steps')) {
      nextActions.push('1. Break the task into smaller capabilities, or increase max steps.');
    }
    if (reason.includes('refusal')) {
      nextActions.push('1. Policy blocked the agent — add routes to policy.json allowedRoutes.');
    }
    if (events.some(e => e.event === 'verify_failed')) {
      nextActions.push(`${nextActions.length + 1}. The model could not populate required outputs — check if those values are visible on the page.`);
    }
    nextActions.push(`${nextActions.length + 1}. Try with \`--attended\` for human-assisted discovery.`);
    nextActions.push(`${nextActions.length + 1}. Review the collapsed trace below to see where the agent diverged.`);
  } else if (type === 'replay_success') {
    nextActions.push('Result is ready to use.');
    if (driftSignals.length) nextActions.push('Review drift signals — these steps are closest to breaking.');
  } else {
    nextActions.push('Review the failure point and candidate table above.');
    nextActions.push(`Re-discover: \`npm run cli -- discover --name ${header.capability} ...\``);
    nextActions.push('Check if the target site has changed layout since discovery.');
  }

  return {
    type, header, contract, result: reportResult, steps, warnings,
    costSummary, provenance, trustState: undefined,
    driftSignals: driftSignals.length ? driftSignals : undefined,
    reviewChecklist, nextActions, candidateTables,
    diagnosis, collapsedSteps, lastObservation,
  };
}

// ── Markdown renderer ──────────────────────────────────────

export function renderMarkdown(report: RunReport): string {
  const L: string[] = [];

  const typeLabel: Record<string, string> = {
    discovery_success: 'Discovery Report — COMPILED',
    discovery_failure: 'Discovery Report — FAILED',
    replay_success: 'Replay Report — SUCCESS',
    replay_failure: 'Replay Report — FAILED',
  };
  L.push(`# ${typeLabel[report.type]}`);
  L.push('');

  // ═══ CASE 1: Discovery Success — review document ═══
  if (report.type === 'discovery_success') {
    // Header: goal, site, artifact name + version, trust state
    L.push('| Field | Value |');
    L.push('|-------|-------|');
    L.push(`| Capability | **${report.header.capability}**${report.header.version ? ` v${report.header.version}` : ''} |`);
    if (report.header.app) L.push(`| App | ${report.header.app} |`);
    if (report.header.site) L.push(`| Site | ${report.header.site} |`);
    if (report.contract?.goal) L.push(`| Goal | ${report.contract.goal} |`);
    L.push(`| Trust | manual — not callable until approved |`);
    L.push(`| Timestamp | ${report.header.timestamp || '—'} |`);
    L.push('');

    // Cost: turns, tokens, duration, model
    if (report.costSummary) {
      L.push('## Cost');
      L.push(`${report.costSummary.turns} turns, ${report.costSummary.totalTokens.toLocaleString()} tokens (${report.costSummary.promptTokens.toLocaleString()} prompt / ${report.costSummary.completionTokens.toLocaleString()} completion), ${(report.costSummary.wallClockMs / 1000).toFixed(1)}s wall clock${report.provenance?.model ? `, model: ${report.provenance.model}` : ''}`);
      L.push('');
    }

    // WHAT WAS LEARNED — the compiled artifact steps in plain language
    L.push(`## What Was Learned (${report.steps.length} steps)`);
    L.push('');
    for (const s of report.steps) {
      L.push(`### Step ${s.number}: ${s.intent}`);
      L.push(`- **Action:** ${s.action}`);
      L.push(`- **Target:** ${s.target}`);
      L.push(`- **How identified:** ${s.identification}`);
      L.push(`- **Checkpoint:** ${s.proof}`);
      L.push(`- **Risk:** ${s.risk}`);
      if (s.issues?.length) {
        L.push('- **Issues:**');
        for (const iss of s.issues) L.push(`  - ${iss}`);
      }
      L.push('');
    }

    // REVIEW CHECKLIST (computed, specific)
    if (report.reviewChecklist?.length) {
      L.push('## Review Checklist');
      L.push('Verify before approving:');
      L.push('');
      for (const item of report.reviewChecklist) L.push(`- [ ] ${item}`);
      L.push('');
    }

    // Exploration summary
    const totalSteps = report.steps.length;
    const issueSteps = report.steps.filter(s => s.issues?.length);
    const productive = totalSteps - issueSteps.length;
    L.push('## Exploration Summary');
    L.push(`${report.costSummary?.turns || totalSteps} turns total, ${productive} productive, ${issueSteps.length} with issues.`);
    if (report.provenance?.humanAssisted) {
      L.push(`Human assisted: yes`);
      if (report.provenance.humanActions?.length) {
        for (const a of report.provenance.humanActions) L.push(`- ${a}`);
      }
    }
    L.push('');

    if (issueSteps.length) {
      L.push('### Where the Model Struggled');
      for (const s of issueSteps) L.push(`- **Step ${s.number}** (${s.intent}): ${s.issues!.join('; ')}`);
      L.push('');
    }

    // Contract details (inputs/outputs/outcomes)
    if (report.contract) {
      const hasInputs = Object.keys(report.contract.inputs).length > 0;
      const hasOutputs = Object.keys(report.contract.outputs).length > 0;
      const hasOutcomes = (report.contract.businessOutcomes?.length || 0) > 0;
      if (hasInputs || hasOutputs || hasOutcomes) {
        L.push('<details>');
        L.push('<summary>Contract (inputs, outputs, outcomes)</summary>');
        L.push('');
        if (hasInputs) {
          L.push('### Inputs');
          L.push('| Name | Type | Pattern | Sensitive |');
          L.push('|------|------|---------|-----------|');
          for (const [k, v] of Object.entries(report.contract.inputs)) {
            L.push(`| ${k} | ${v.type} | ${v.pattern || '—'} | ${v.sensitive ? 'yes' : 'no'} |`);
          }
          L.push('');
        }
        if (hasOutputs) {
          L.push('### Outputs');
          L.push('| Name | Type | Sensitive |');
          L.push('|------|------|-----------|');
          for (const [k, v] of Object.entries(report.contract.outputs)) {
            L.push(`| ${k} | ${v.type} | ${v.sensitive ? 'yes' : 'no'} |`);
          }
          L.push('');
        }
        if (hasOutcomes) {
          L.push('### Business Outcomes');
          for (const o of report.contract.businessOutcomes!) L.push(`- \`${o}\``);
          L.push('');
        }
        L.push('</details>');
        L.push('');
      }
    }

    // Full trace collapsed by default
    L.push('<details>');
    L.push('<summary>Full trace</summary>');
    L.push('');
    L.push('| # | Step | Action | Checkpoint | Risk |');
    L.push('|---|------|--------|------------|------|');
    for (const s of report.steps) {
      L.push(`| ${s.number} | ${s.id} | ${s.action} | ${s.proof} | ${s.risk} |`);
    }
    L.push('');
    L.push('</details>');
    L.push('');

  // ═══ CASE 2: Discovery Failure — diagnosis-first ═══
  } else if (report.type === 'discovery_failure') {
    // Top: goal, site, stop condition
    L.push('| Field | Value |');
    L.push('|-------|-------|');
    L.push(`| Capability | **${report.header.capability}** |`);
    if (report.header.app) L.push(`| App | ${report.header.app} |`);
    if (report.header.site) L.push(`| Site | ${report.header.site} |`);
    if (report.contract?.goal) L.push(`| Goal | ${report.contract.goal} |`);
    L.push(`| Stop condition | ${report.result?.status || 'unknown'}: ${report.result?.reason || '—'} |`);
    L.push(`| Timestamp | ${report.header.timestamp || '—'} |`);
    if (report.header.durationMs != null) L.push(`| Duration | ${(report.header.durationMs / 1000).toFixed(1)}s |`);
    L.push('');

    // THE DIAGNOSIS
    L.push('## Diagnosis');
    L.push('');
    L.push(report.diagnosis || 'no pattern detected');
    L.push('');

    // Where it stopped
    if (report.lastObservation) {
      L.push('## Where It Stopped');
      L.push(`- **Step:** ${report.lastObservation.stepNumber}`);
      L.push(`- **URL:** ${report.lastObservation.url}`);
      L.push(`- **On screen:** ${report.lastObservation.pageContext}`);
      L.push(`- **Still needed:** ${report.lastObservation.stillNeeded}`);
      L.push('');
    }

    // Next actions ranked
    L.push('## Next Actions');
    for (const a of report.nextActions) L.push(`- ${a}`);
    L.push('');

    // Cost summary
    if (report.costSummary) {
      L.push('## Cost');
      L.push(`${report.costSummary.totalTokens.toLocaleString()} tokens, ${report.costSummary.turns} turns, ${(report.costSummary.wallClockMs / 1000).toFixed(1)}s`);
      L.push('');
    }

    // Trajectory — collapsed by default, with repetition folding
    L.push('<details>');
    L.push(`<summary>Trajectory (${report.steps.length} steps)</summary>`);
    L.push('');
    if (report.collapsedSteps?.length) {
      for (const group of report.collapsedSteps) {
        const icon = group.result === 'passed' ? 'pass' : group.result === 'failed' ? 'FAIL' : 'skip';
        if (group.count > 1) {
          L.push(`- **Steps ${group.startStep}-${group.endStep}:** ${group.summary} (${group.count}x) [${icon}]`);
        } else {
          // Find the original step for full detail
          const step = report.steps.find(s => s.number === group.startStep);
          if (step) {
            L.push(`${step.number}. [${icon}] **${step.action}**`);
            if (step.intent && step.intent !== step.action) L.push(`   _${step.intent}_`);
            if (step.identification) L.push(`   ${step.identification}`);
            if (step.issues?.length) {
              for (const iss of step.issues) L.push(`   - ${iss}`);
            }
          }
        }
      }
    } else {
      for (const s of report.steps) {
        const icon = s.result === 'passed' ? 'pass' : s.result === 'failed' ? 'FAIL' : 'skip';
        L.push(`${s.number}. [${icon}] **${s.action}**`);
        if (s.intent && s.intent !== s.action) L.push(`   _${s.intent}_`);
        if (s.identification) L.push(`   ${s.identification}`);
        if (s.issues?.length) {
          for (const iss of s.issues) L.push(`   - ${iss}`);
        }
      }
    }
    L.push('');
    L.push('</details>');
    L.push('');

    // Early return — next actions already rendered above
    L.push('---');
    L.push('_Generated by computeruse-automation-system. Deterministic — no LLM in report generation._');
    return L.join('\n');

  // ═══ CASE 3: Replay Success ═══
  } else if (report.type === 'replay_success') {
    // Header table
    L.push('| Field | Value |');
    L.push('|-------|-------|');
    L.push(`| Capability | **${report.header.capability}**${report.header.version ? ` v${report.header.version}` : ''} |`);
    if (report.header.app) L.push(`| App | ${report.header.app} |`);
    if (report.header.site) L.push(`| Site | ${report.header.site} |`);
    L.push(`| Timestamp | ${report.header.timestamp || '—'} |`);
    if (report.header.durationMs != null) L.push(`| Duration | ${(report.header.durationMs / 1000).toFixed(1)}s |`);
    if (report.header.caller) L.push(`| Caller | ${report.header.caller} |`);
    L.push('');

    L.push('## Result');
    L.push(`**Status:** ${report.result?.status}`);
    if (report.result?.outcome) L.push(`**Outcome:** ${report.result.outcome}`);
    L.push('');

    if (report.result?.outputs && Object.keys(report.result.outputs).length) {
      L.push('## Outputs');
      L.push('| Name | Value |');
      L.push('|------|-------|');
      for (const [k, v] of Object.entries(report.result.outputs)) {
        L.push(`| ${k} | ${v} |`);
      }
      L.push('');
    }

    L.push('## Step Timeline');
    L.push('| # | Step | Action | Margin | Result |');
    L.push('|---|------|--------|--------|--------|');
    for (const s of report.steps) {
      const m = s.margin != null ? s.margin.toFixed(3) : '—';
      const icon = s.result === 'recovered' ? '~' : s.result === 'passed' ? 'pass' : 'FAIL';
      L.push(`| ${s.number} | ${s.id} | ${s.action} | ${m} | ${icon} |`);
    }
    L.push('');

    if (report.driftSignals?.length) {
      L.push('## Drift Signals');
      L.push('These steps will break first if the site changes:');
      L.push('');
      for (const d of report.driftSignals) L.push(`- ${d}`);
      L.push('');
    }

    const recovered = report.steps.filter(s => s.result === 'recovered');
    if (recovered.length) {
      L.push('## Recovery Events');
      L.push('');
      for (const s of recovered) {
        L.push(`### Step ${s.number}: ${s.intent}`);
        if (s.issues?.length) {
          for (const iss of s.issues) L.push(`${iss}`);
        }
        L.push('');
      }
    }

  // ═══ CASE 4: Replay Failure — candidate table ═══
  } else if (report.type === 'replay_failure') {
    // Header table
    L.push('| Field | Value |');
    L.push('|-------|-------|');
    L.push(`| Capability | **${report.header.capability}**${report.header.version ? ` v${report.header.version}` : ''} |`);
    if (report.header.app) L.push(`| App | ${report.header.app} |`);
    if (report.header.site) L.push(`| Site | ${report.header.site} |`);
    L.push(`| Timestamp | ${report.header.timestamp || '—'} |`);
    if (report.header.durationMs != null) L.push(`| Duration | ${(report.header.durationMs / 1000).toFixed(1)}s |`);
    L.push('');

    const failStep = report.steps.find(s => s.result === 'failed');
    L.push('## Failure Point');
    if (failStep) {
      L.push(`**Step ${failStep.number}:** ${failStep.id} — ${failStep.intent}`);
      L.push(`- **Action:** ${failStep.action}`);
      L.push(`- **Target:** ${failStep.target}`);
      L.push(`- **How identified:** ${failStep.identification}`);
      L.push(`- **Expected:** ${failStep.proof}`);
      if (report.result?.reason) L.push(`- **Observed:** ${report.result.reason}`);
      L.push('');

      // Show failing step's candidate table expanded and prominent
      if (report.candidateTables?.length) {
        const failTable = report.candidateTables.find(ct => ct.stepId === failStep.id);
        if (failTable) {
          L.push('### Candidates at Failure');
          L.push(`What the scorer considered for "${failTable.stepIntent}":`);
          L.push('');
          if (failTable.candidates.length) {
            L.push('| Rank | Score | Properties |');
            L.push('|------|-------|------------|');
            for (const c of failTable.candidates) {
              L.push(`| #${c.rank} | ${c.score.toFixed(2)} | ${c.matchSummary} |`);
            }
          } else {
            L.push('No candidates scored.');
          }
          L.push('');
        }
      }
    } else {
      L.push(`Status: ${report.result?.status || 'unknown'}`);
      if (report.result?.reason) L.push(`Reason: ${report.result.reason}`);
      L.push('');
    }

    // Other steps' candidate tables collapsed
    if (report.candidateTables?.length) {
      const otherTables = report.candidateTables.filter(ct => !failStep || ct.stepId !== failStep.id);
      if (otherTables.length) {
        L.push('<details>');
        L.push('<summary>Candidate tables for other steps</summary>');
        L.push('');
        for (const ct of otherTables) {
          L.push(`#### ${ct.stepId}: ${ct.stepIntent}`);
          if (ct.candidates.length) {
            L.push('| Rank | Score | Properties |');
            L.push('|------|-------|------------|');
            for (const c of ct.candidates) {
              L.push(`| #${c.rank} | ${c.score.toFixed(2)} | ${c.matchSummary} |`);
            }
          } else {
            L.push('No candidates scored.');
          }
          L.push('');
        }
        L.push('</details>');
        L.push('');
      }
    }

    L.push('## Full Step Timeline');
    L.push('| # | Step | Action | Margin | Result |');
    L.push('|---|------|--------|--------|--------|');
    for (const s of report.steps) {
      const m = s.margin != null ? s.margin.toFixed(3) : '—';
      const icon = s.result === 'passed' ? 'pass' : s.result === 'failed' ? 'FAIL' : 'skip';
      L.push(`| ${s.number} | ${s.id} | ${s.action} | ${m} | ${icon} |`);
    }
    L.push('');

    if (report.driftSignals?.length) {
      L.push('## Drift Signals');
      for (const d of report.driftSignals) L.push(`- ${d}`);
      L.push('');
    }
  }

  // Next actions (all remaining cases — discovery_failure returns early above)
  L.push('## Next Actions');
  for (const a of report.nextActions) L.push(`- ${a}`);
  L.push('');

  L.push('---');
  L.push('_Generated by computeruse-automation-system. Deterministic — no LLM in report generation._');

  return L.join('\n');
}
