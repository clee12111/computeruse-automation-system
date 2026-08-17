// src/schema/describe-result.ts — Pure function: typed result → human-readable strings.
// Deterministic, no I/O, no model. Covers all outcomes.
// summary: one sentence. detail: what happened. nextActions: what to do.

import type { DescribedResult } from './results.js';

interface ResultContext {
  capabilityName?: string;
  durationMs?: number;
  recovered?: boolean;
  goal?: string;
  site?: string;
}

// ── Replay results ──────────────────────────────────────────

export function describeReplayResult(result: any, ctx: ResultContext = {}): DescribedResult {
  const cap = ctx.capabilityName || 'the capability';
  const dur = ctx.durationMs ? ` in ${(ctx.durationMs / 1000).toFixed(1)}s` : '';

  switch (result.status) {
    case 'SUCCESS': {
      const keys = Object.keys(result.outputs || {});
      const vals = keys.map(k => {
        const v = result.outputs[k];
        if (typeof v === 'number') return `${k}: ${typeof v === 'number' && k.toLowerCase().includes('balance') ? '$' + v.toLocaleString() : v}`;
        return `${k}: ${v}`;
      });
      const outputStr = vals.length ? vals.join(', ') : 'no output values';
      const recoveryNote = ctx.recovered || result.recovered
        ? ' The run recovered from an error mid-flow (session expired and was re-established).'
        : '';

      return {
        summary: `${cap} completed successfully — ${outputStr}.`,
        detail: `All ${keys.length ? keys.length + ' outputs' : 'steps'} returned${dur}.${recoveryNote}`,
        nextActions: [
          'The result is ready to use.',
          ...(ctx.recovered || result.recovered ? ['Review the run journal to see the recovery path.'] : []),
        ],
      };
    }

    case 'BUSINESS_OUTCOME': {
      const code = (result.code || 'UNKNOWN').replace(/_/g, ' ').toLowerCase();
      return {
        summary: `${cap} answered: ${code}.`,
        detail: `This is a known answer, not an error. The system checked and determined: "${code}."${dur ? ` Completed${dur}.` : ''}`,
        nextActions: [
          'This is a valid business response — handle it as data, not as a failure.',
          `If "${code}" is unexpected, verify the input values.`,
        ],
      };
    }

    case 'ESCALATED': {
      return {
        summary: `${cap} was escalated to a human operator.`,
        detail: `The system paused at a point it couldn't resolve on its own. Resolution: ${result.resolution || 'pending'}.${result.notes ? ' Notes: ' + result.notes : ''}`,
        nextActions: [
          'Review the run journal to see where the system paused.',
          'If the escalation was caused by ambiguity, consider re-discovering the capability with more specific targets.',
          'No data was changed — the system stops before acting when unsure.',
        ],
      };
    }

    case 'HARD_FAILURE': {
      const step = result.stepId || 'unknown';
      const isGateStop = result.observed?.includes('not approved');
      const isTimeout = result.observed?.includes('timeout') || result.observed?.includes('Timeout');
      const isNotResolved = result.observed?.includes('not resolved') || result.observed?.includes('Target not');
      const isRecoveryFail = result.observed?.includes('Recovery');

      if (isGateStop) {
        return {
          summary: `${cap} stopped: this step requires approval that hasn't been granted.`,
          detail: `Step ${step} is marked as irreversible (it changes data). The capability must be approved before this step can execute. Nothing was changed.`,
          nextActions: [
            `Approve ${cap} with: npm run cli -- approve ${ctx.capabilityName || '<name>'} --version <version>`,
            'Or approve through the console at Sites → [site] → [tool] → Approve.',
            'Review the script first — irreversible steps are marked with ⚠.',
          ],
        };
      }

      if (isNotResolved) {
        return {
          summary: `${cap} failed: couldn't find the expected element on the page at step ${step}.`,
          detail: `The system looked for a specific element but couldn't match it confidently. Expected: ${result.expected?.substring(0, 80)}. What it saw: ${result.observed?.substring(0, 100)}.`,
          nextActions: [
            'The site may have changed its layout since this capability was recorded.',
            'Check the margin values in the run journal — low margins indicate elements that are hard to distinguish.',
            'Re-discover the capability to record the current layout.',
          ],
        };
      }

      if (isTimeout) {
        return {
          summary: `${cap} timed out at step ${step} waiting for the expected page state.`,
          detail: `After 30 seconds, the page didn't show what the system was waiting for. Expected: ${result.expected?.substring(0, 80)}.`,
          nextActions: [
            'The page may be loading slowly, or the expected content may no longer appear.',
            'Check if the target site is reachable and responding normally.',
            'Review the screenshots in the run journal to see the actual page state.',
          ],
        };
      }

      if (isRecoveryFail) {
        return {
          summary: `${cap} detected an error and tried to recover, but recovery failed at step ${step}.`,
          detail: `An error was detected (e.g. session expired) and the system attempted its recovery route, but the recovery steps didn't succeed. ${result.observed?.substring(0, 100)}.`,
          nextActions: [
            'Check the error library configuration for this site (errors/<app>.json).',
            'The recovery steps may need updating if the login page has changed.',
            'Review the run journal to see exactly where recovery failed.',
          ],
        };
      }

      return {
        summary: `${cap} failed at step ${step}.`,
        detail: `Expected: ${result.expected?.substring(0, 80)}. Observed: ${result.observed?.substring(0, 100)}.`,
        nextActions: [
          'Review the run journal and screenshots to understand what the page looked like.',
          'If the site changed, re-discover the capability.',
          'If the error is intermittent, try running again.',
        ],
      };
    }

    default:
      return {
        summary: `${cap} returned an unknown status: ${result.status}.`,
        nextActions: ['Check the raw result JSON.'],
      };
  }
}

// ── Pre-flight results ──────────────────────────────────────

export function describeInvalidInput(message: string, ctx: ResultContext = {}): DescribedResult {
  // Parse out the param name and pattern from the message
  const paramMatch = message.match(/Input "(\w+)" value "([^"]*)" does not match pattern (.+)/);
  const missingMatch = message.match(/Missing required input: "(\w+)"/);

  if (paramMatch) {
    const [, param, value, pattern] = paramMatch;
    return {
      summary: `Invalid input: "${value}" is not a valid ${param}.`,
      detail: `The value "${value}" doesn't match the required format: ${pattern}.`,
      nextActions: [
        `Provide a ${param} that matches ${pattern}.`,
        `Example: a 5-digit number like "60020".`,
      ],
    };
  }

  if (missingMatch) {
    return {
      summary: `Missing required input: ${missingMatch[1]}.`,
      detail: message,
      nextActions: [`Provide a value for "${missingMatch[1]}".`],
    };
  }

  return { summary: `Invalid input: ${message}`, nextActions: ['Check the input requirements.'] };
}

export function describeTrustBlocked(capName: string, version: string): DescribedResult {
  return {
    summary: `${capName}@${version} hasn't been approved for production use.`,
    detail: 'Capabilities must be reviewed and approved by a human before they can be executed. This is a safety control, not an error.',
    nextActions: [
      `Review the script: open ${capName} in the console at Sites → [site] → [tool].`,
      `Approve it: npm run cli -- approve ${capName} --version ${version}`,
      'Approvals require a named human — the system cannot approve itself.',
    ],
  };
}

// ── Discovery results ───────────────────────────────────────

export function describeDiscoveryResult(result: any, ctx: ResultContext = {}): DescribedResult {
  const goalPhrase = ctx.goal ? `how to ${ctx.goal}` : 'the task';
  const sitePhrase = ctx.site ? ` on ${ctx.site}` : '';
  const capName = ctx.capabilityName || result.artifact?.name;

  if (result.status === 'compiled') {
    const art = result.artifact;
    const steps = art?.steps?.length || '?';

    // ── Quality checks (deterministic) ─────────────────────
    const warnings: string[] = [];

    if (art?.steps && art.inputs && art.outputs) {
      // 1. Unused inputs: declared inputs never referenced in any step's action value
      const referencedInputs = new Set<string>();
      for (const step of art.steps) {
        const val = step.action?.value;
        if (val && typeof val === 'object' && '$input' in val) {
          referencedInputs.add((val as any).$input);
        }
      }
      for (const [inputName, decl] of Object.entries(art.inputs)) {
        if (!(decl as any).sensitive && !referencedInputs.has(inputName)) {
          warnings.push(`Input "${inputName}" is declared but never used in any step — the script may not be passing it to the UI.`);
        }
      }

      // 2. Unreached outputs: declared outputs never populated by a read step
      const populatedOutputs = new Set<string>();
      for (const step of art.steps) {
        if (step.action?.verb === 'read' && step.action?.saveTo) {
          populatedOutputs.add(step.action.saveTo);
        }
      }
      for (const outputName of Object.keys(art.outputs)) {
        if (!populatedOutputs.has(outputName)) {
          warnings.push(`Output "${outputName}" is declared but no step reads it — the script won't return this value.`);
        }
      }

      // 3. Repeated steps: same verb + same target name in sequence (stuck loop)
      for (let i = 1; i < art.steps.length; i++) {
        const prev = art.steps[i - 1];
        const curr = art.steps[i];
        const prevTarget = prev.target?.properties?.name || prev.target?.properties?.role;
        const currTarget = curr.target?.properties?.name || curr.target?.properties?.role;
        if (prev.action?.verb === curr.action?.verb && prevTarget === currTarget && prev.action?.verb !== 'navigate') {
          warnings.push(`Steps "${prev.id}" and "${curr.id}" repeat the same action (${curr.action.verb}) on "${currTarget}" — the agent may have been stuck.`);
        }
      }

      // 4. No read steps at all
      const hasRead = art.steps.some((s: any) => s.action?.verb === 'read');
      if (!hasRead && Object.keys(art.outputs).length > 0) {
        warnings.push('No read steps in the script, but outputs are declared — the script never extracts a value from the page.');
      }
    }

    // ── Build description ──────────────────────────────────
    const lines: string[] = [];
    lines.push(`A new capability "${capName || 'unnamed'}" (v${art?.version || '?'}) was recorded with ${steps} steps.`);

    // Inputs
    if (art?.inputs && Object.keys(art.inputs).length > 0) {
      const inputDescs = Object.entries(art.inputs).map(([k, v]: [string, any]) => {
        const parts = [k];
        if (v.sensitive) parts.push('(sensitive — from env, not passed by caller)');
        if (v.pattern) parts.push(`format: ${v.pattern}`);
        return parts.join(' ');
      });
      lines.push(`\nInputs: ${inputDescs.join('; ')}.`);
    }

    // Outputs
    if (art?.outputs && Object.keys(art.outputs).length > 0) {
      const outputDescs = Object.entries(art.outputs).map(([k, v]: [string, any]) =>
        `${k} (${v.type}${v.sensitive ? ', sensitive' : ''})`,
      );
      lines.push(`Outputs: ${outputDescs.join('; ')}.`);
    }

    // Business outcomes
    if (art?.businessOutcomes && Object.keys(art.businessOutcomes).length > 0) {
      lines.push(`Known outcomes: ${Object.keys(art.businessOutcomes).join(', ')}.`);
    }

    // Step-by-step walkthrough
    if (art?.steps && art.steps.length > 0) {
      lines.push('\nScript walkthrough:');
      for (const step of art.steps) {
        const verb = step.action?.verb || '?';
        const targetName = step.target?.properties?.name || step.target?.properties?.role || '?';
        const risk = step.risk === 'risky' ? ' ⚠ RISKY' : '';
        const value = step.action?.value
          ? typeof step.action.value === 'string'
            ? ` "${step.action.value}"`
            : ` {input: ${(step.action.value as any).$input}}`
          : '';
        lines.push(`  ${step.id}: ${step.intent || verb} → ${verb}${value} on "${targetName}"${risk}`);
      }
    }

    // Warnings
    if (warnings.length > 0) {
      lines.push(`\n⚠ QUALITY WARNINGS (${warnings.length}):`);
      for (const w of warnings) {
        lines.push(`  - ${w}`);
      }
      lines.push('\nThis script has issues. Consider re-running discovery with a more specific goal before approving.');
    }

    lines.push('\nThis capability is NOT callable until a human reviews and approves it. The system proposes, humans authorize.');

    const qualityVerdict = warnings.length === 0 ? 'clean' : `${warnings.length} warning(s)`;
    return {
      summary: `Learned ${goalPhrase}${sitePhrase} — ${steps} steps (${qualityVerdict}). Not callable yet: a human must approve it.`,
      detail: lines.join('\n'),
      nextActions: [
        ...(warnings.length > 0
          ? [`⚠ This script has ${warnings.length} quality issue(s) — re-discovery with a tighter goal is recommended before approving.`]
          : []),
        `Review the script in the console: Sites → ${ctx.site || '[site]'} → ${capName || '[tool]'}.`,
        `Approve it: npm run cli -- approve ${capName || '<name>'} --version ${result.artifact?.version || '1.0.0'}`,
        'Until approved, this capability will not appear in the tool list and cannot be called.',
      ],
    };
  }

  if (result.status === 'dead_end') {
    const reason = result.reason || 'couldn\'t complete the task';
    const stuckAt = reason.includes('Same action') ? 'The AI found the right element but the page didn\'t change — it may need a different approach.'
      : reason.includes('timeout') || reason.includes('Wall clock') ? 'The exploration ran out of time.'
      : reason.includes('Max steps') ? 'The task required more steps than the limit allows.'
      : `The AI got stuck: ${reason}`;
    return {
      summary: `Couldn't learn ${goalPhrase}${sitePhrase}: ${reason}.`,
      detail: stuckAt,
      nextActions: [
        'Try rephrasing the goal to be more specific.',
        'If the task requires many steps, break it into smaller capabilities.',
        'Review the discovery journal to see how far it got.',
      ],
    };
  }

  if (result.status === 'aborted') {
    const reason = result.reason || 'a guardrail fired';
    const isPolicy = reason.includes('refusal');
    return {
      summary: `Discovery of ${goalPhrase}${sitePhrase} was stopped: ${reason}.`,
      detail: isPolicy ? 'The system tried to access a page or action that policy doesn\'t allow.' : `Reason: ${reason}`,
      nextActions: [
        ...(isPolicy ? ['Check policy.json — the target routes may need to be added to the allowlist.'] : []),
        'Review the discovery journal to see what happened.',
        'Try a different goal or starting path.',
      ],
    };
  }

  if (result.status === 'running') {
    const steps = result.stepsSoFar ?? 0;
    return {
      summary: `Discovery in progress${sitePhrase}: ${steps} steps so far.`,
      detail: `The AI is exploring ${ctx.site || 'the application'} to learn ${goalPhrase}. This typically takes 30–60 seconds.`,
      nextActions: [
        'Poll check_discovery with the runId to see progress.',
        'The result will be "compiled" (success) or "dead_end" (couldn\'t complete).',
      ],
    };
  }

  return { summary: `Discovery returned: ${result.status}.`, nextActions: ['Check the raw result.'] };
}

// ── Escalation with rejected handback ───────────────────────

export function describeEscalationWithHandback(result: any, journalEvents: any[] = [], ctx: ResultContext = {}): DescribedResult {
  const base = describeReplayResult(result, ctx);

  // Check for rejected handback claims in the journal
  const rejections = journalEvents.filter((e: any) => e.event === 'handback_rejected');
  if (rejections.length > 0) {
    const rej = rejections[0];
    const claimType = rej.claim || 'skip';
    const reason = rej.reason || 'the page state didn\'t match';
    base.detail = (base.detail || '') +
      ` A human claimed the step was handled (${claimType}); the system checked the live screen, disagreed (${reason}), and did not accept the claim.`;
  }

  return base;
}
