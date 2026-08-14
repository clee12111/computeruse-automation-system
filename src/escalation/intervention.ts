// src/escalation/intervention.ts — Escalation channel seam.
// DESIGN_MAP D8: pause/cede/verified-handback (r/s/a).

import { createInterface } from 'node:readline';
import type { InterventionRequest } from '../schema/results.js';

// ── Handback claims ─────────────────────────────────────────
export type HandbackClaim =
  | { kind: 'retry' }
  | { kind: 'skip' }
  | { kind: 'abort'; notes?: string }
  | { kind: 'approve' }; // risky-step approval

// ── Channel interface ───────────────────────────────────────
export interface EscalationChannel {
  request(req: InterventionRequest): Promise<HandbackClaim>;
}

// ── TerminalChannel (production: blocking stdin r/s/a) ──────
export class TerminalChannel implements EscalationChannel {
  async request(req: InterventionRequest): Promise<HandbackClaim> {
    console.log('\n' + '═'.repeat(60));
    console.log('  ESCALATION — Human intervention required');
    console.log('═'.repeat(60));
    console.log(`  Capability: ${req.capability} v${req.version}`);
    console.log(`  Step:       ${req.stepId} — ${req.intent}`);
    console.log(`  Reason:     ${req.reason}`);
    console.log(`  Expected:   ${req.expected}`);
    console.log(`  Observed:   ${req.observed}`);
    console.log(`  Screenshot: ${req.screenshotRef}`);
    console.log('─'.repeat(60));
    console.log('  The browser is paused. You may interact with it now.');
    console.log('  (r)etry — re-run this step');
    console.log('  (s)kip  — skip (expect must pass on live screen)');
    console.log('  (a)bort — end run as ESCALATED');
    console.log('─'.repeat(60));

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      const ask = () => {
        rl.question('  > ', (answer) => {
          const c = answer.trim().toLowerCase();
          if (c === 'r' || c === 'retry') { rl.close(); resolve({ kind: 'retry' }); }
          else if (c === 's' || c === 'skip') { rl.close(); resolve({ kind: 'skip' }); }
          else if (c === 'a' || c === 'abort') {
            rl.question('  Notes (optional): ', (notes) => {
              rl.close();
              resolve({ kind: 'abort', notes: notes.trim() || undefined });
            });
          } else {
            console.log('  Enter r, s, or a');
            ask();
          }
        });
      };
      ask();
    });
  }
}

// ── ScriptedChannel (tests: returns scripted claims) ────────
export class ScriptedChannel implements EscalationChannel {
  private claims: HandbackClaim[];
  private index = 0;
  public requests: InterventionRequest[] = [];
  private beforeClaimHook?: () => Promise<void>;

  constructor(claims: HandbackClaim[], opts?: { beforeClaim?: () => Promise<void> }) {
    this.claims = claims;
    this.beforeClaimHook = opts?.beforeClaim;
  }

  async request(req: InterventionRequest): Promise<HandbackClaim> {
    this.requests.push(req);
    // Let the test interact with the browser before returning the claim
    if (this.beforeClaimHook) await this.beforeClaimHook();
    if (this.index >= this.claims.length) {
      return { kind: 'abort', notes: 'Scripted claims exhausted' };
    }
    return this.claims[this.index++];
  }
}
