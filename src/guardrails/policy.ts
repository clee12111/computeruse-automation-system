// src/guardrails/policy.ts — Policy loading + enforcement.
// DESIGN_MAP D9: enforced BELOW the intelligence (no prompt can bypass).
// Violations return typed PolicyViolation — never throw past the caller.

import { readFileSync } from 'node:fs';
import type { Policy, PolicyViolation } from '../surface/surface.js';

export function loadPolicy(filePath: string): Policy {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  return {
    allowedOrigins: raw.allowedOrigins || [],
    allowedRoutes: raw.allowedRoutes || [],
    allowedVerbs: raw.allowedVerbs || [],
  };
}

/** Check if an action is allowed by policy. Returns null if allowed, violation if blocked. */
export function checkPolicy(
  policy: Policy,
  origin: string,
  route: string,
  verb: string,
): PolicyViolation | null {
  // Check origin
  if (policy.allowedOrigins.length > 0 && !policy.allowedOrigins.includes(origin)) {
    return { rule: 'origin', attempted: origin };
  }

  // Check route (glob-style: /t/* matches /t/cascade-cu/search)
  if (policy.allowedRoutes.length > 0) {
    const routeAllowed = policy.allowedRoutes.some(pattern => {
      if (pattern.endsWith('*')) {
        return route.startsWith(pattern.slice(0, -1));
      }
      return route === pattern;
    });
    if (!routeAllowed) {
      return { rule: 'route', attempted: route };
    }
  }

  // Check verb
  if (policy.allowedVerbs.length > 0 && !policy.allowedVerbs.includes(verb)) {
    return { rule: 'verb', attempted: verb };
  }

  return null;
}
