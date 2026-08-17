// test/describe-result.test.ts — Unit tests for the result describer.

import { describe, it, expect } from 'vitest';
import {
  describeReplayResult,
  describeInvalidInput,
  describeTrustBlocked,
  describeDiscoveryResult,
  describeEscalationWithHandback,
} from '../src/schema/describe-result.js';

describe('describeReplayResult', () => {

  it('SUCCESS — returns outputs in plain language', () => {
    const d = describeReplayResult(
      { status: 'SUCCESS', outputs: { savingsBalance: 10426.23 } },
      { capabilityName: 'lookup-dense-savings' },
    );
    expect(d.summary).toContain('lookup-dense-savings');
    expect(d.summary).toContain('successfully');
    expect(d.summary).toContain('10,426.23');
    expect(d.nextActions.length).toBeGreaterThan(0);
  });

  it('SUCCESS with recovery — mentions the recovery', () => {
    const d = describeReplayResult(
      { status: 'SUCCESS', outputs: { savingsBalance: 10426.23 } },
      { capabilityName: 'lookup-dense-savings', recovered: true },
    );
    expect(d.summary).toContain('successfully');
    expect(d.detail).toContain('recovered');
  });

  it('BUSINESS_OUTCOME — says it is an answer, not a failure', () => {
    const d = describeReplayResult(
      { status: 'BUSINESS_OUTCOME', code: 'MEMBER_NOT_FOUND' },
      { capabilityName: 'lookup-dense-savings' },
    );
    expect(d.summary).toContain('answered');
    expect(d.summary).toContain('member not found');
    expect(d.detail).toContain('not an error');
    expect(d.nextActions.some(a => a.includes('not as a failure'))).toBe(true);
  });

  it('ESCALATED — says nothing was changed', () => {
    const d = describeReplayResult(
      { status: 'ESCALATED', resolution: 'abort', notes: 'ambiguity' },
      { capabilityName: 'test-cap' },
    );
    expect(d.summary).toContain('escalated');
    expect(d.nextActions.some(a => a.includes('No data was changed'))).toBe(true);
  });

  it('HARD_FAILURE (element not resolved) — suggests re-discovery', () => {
    const d = describeReplayResult(
      { status: 'HARD_FAILURE', stepId: 's2', expected: '{}', observed: 'Target not resolved', evidenceRefs: [] },
      { capabilityName: 'test-cap' },
    );
    expect(d.summary).toContain('couldn\'t find');
    expect(d.summary).toContain('s2');
    expect(d.nextActions.some(a => a.includes('Re-discover'))).toBe(true);
  });

  it('HARD_FAILURE (gate stop) — says who must approve', () => {
    const d = describeReplayResult(
      { status: 'HARD_FAILURE', stepId: 's13', expected: '{}', observed: 'Risky step s13: capability not approved for unattended execution', evidenceRefs: [] },
      { capabilityName: 'transfer-funds' },
    );
    expect(d.summary).toContain('approval');
    expect(d.nextActions.some(a => a.includes('approve'))).toBe(true);
  });

  it('HARD_FAILURE (timeout) — suggests checking the site', () => {
    const d = describeReplayResult(
      { status: 'HARD_FAILURE', stepId: 's5', expected: '{}', observed: 'Arbitration timeout (30000ms)', evidenceRefs: [] },
      { capabilityName: 'test-cap' },
    );
    expect(d.summary).toContain('timed out');
    expect(d.nextActions.some(a => a.includes('reachable'))).toBe(true);
  });
});

describe('describeInvalidInput', () => {
  it('pattern mismatch — names the param and gives an example', () => {
    const d = describeInvalidInput('Input "memberId" value "abc" does not match pattern ^[0-9]{5}$');
    expect(d.summary).toContain('"abc"');
    expect(d.summary).toContain('memberId');
    expect(d.nextActions.some(a => a.includes('60020'))).toBe(true);
  });

  it('missing input — names the param', () => {
    const d = describeInvalidInput('Missing required input: "memberId"');
    expect(d.summary).toContain('memberId');
  });
});

describe('describeTrustBlocked', () => {
  it('names the capability and says who must approve', () => {
    const d = describeTrustBlocked('lookup-dense-savings', '1.1.0');
    expect(d.summary).toContain('lookup-dense-savings@1.1.0');
    expect(d.summary).toContain('approved');
    expect(d.nextActions.some(a => a.includes('approve'))).toBe(true);
    expect(d.nextActions.some(a => a.includes('cannot approve itself'))).toBe(true);
  });
});

describe('describeDiscoveryResult with context (Task B)', () => {
  it('compiled with goal+site — specific summary', () => {
    const d = describeDiscoveryResult(
      { status: 'compiled', artifact: { name: 'lookup-checking-balance', version: '1.0.0', steps: [{},{},{},{},{},{},{},{}] } },
      { goal: "look up a member's savings balance", site: 'Cascade CU', capabilityName: 'lookup-checking-balance' },
    );
    expect(d.summary).toContain("look up a member's savings balance");
    expect(d.summary).toContain('Cascade CU');
    expect(d.summary).toContain('8 steps');
    expect(d.summary).toContain('Not callable yet');
    expect(d.detail).toContain('NOT callable');
    expect(d.detail).toContain('proposes, humans authorize');
  });

  it('dead_end with goal+site — names where it got stuck', () => {
    const d = describeDiscoveryResult(
      { status: 'dead_end', reason: 'Same action repeated 5 times' },
      { goal: 'read checking balance', site: 'ParaBank' },
    );
    expect(d.summary).toContain('read checking balance');
    expect(d.summary).toContain('ParaBank');
    expect(d.detail).toContain("didn't change");
  });

  it('aborted with goal+site — names which guardrail', () => {
    const d = describeDiscoveryResult(
      { status: 'aborted', reason: '3 guardrail refusals' },
      { goal: 'transfer funds', site: 'Altoro Mutual' },
    );
    expect(d.summary).toContain('transfer funds');
    expect(d.summary).toContain('Altoro Mutual');
    expect(d.nextActions.some(a => a.includes('policy'))).toBe(true);
  });

  it('running — shows progress', () => {
    const d = describeDiscoveryResult(
      { status: 'running', stepsSoFar: 5 },
      { goal: 'look up loan balance', site: 'Cascade CU' },
    );
    expect(d.summary).toContain('in progress');
    expect(d.summary).toContain('5 steps');
  });
});

describe('describeEscalationWithHandback (Task C)', () => {
  it('rejected handback — says the system checked and disagreed', () => {
    const result = { status: 'ESCALATED', resolution: 'abort', notes: 'Cannot resolve ambiguity' };
    const journal = [
      { event: 'control_transfer', to: 'human', stepId: 's7', reason: 'Arbitration timeout' },
      { event: 'handback_rejected', claim: 'skip', reason: 'expect not met on live screen' },
      { event: 'handback', claim: 'abort', notes: 'Cannot resolve ambiguity' },
    ];
    const d = describeEscalationWithHandback(result, journal, { capabilityName: 'test-cap' });
    expect(d.detail).toContain('human claimed the step was handled');
    expect(d.detail).toContain('checked the live screen');
    expect(d.detail).toContain('disagreed');
    expect(d.detail).toContain('did not accept the claim');
  });
});
