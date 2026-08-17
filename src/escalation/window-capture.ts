// src/escalation/window-capture.ts — Captures what changed during a human intervention window.
// Pure diff computation: before/after observation → plain-language summary.
// No model, no inference — factual record only.

import type { Observation, ElementInfo } from '../surface/surface.js';

export interface WindowSnapshot {
  url: string;
  elementCount: number;
  frameElementCounts: Record<string, number>;
  headings: string[];
  dialogTexts: string[];
  formFieldNames: string[];  // attrName or name, never values
}

export interface HumanActionsDiff {
  urlChanged: boolean;
  urlFrom?: string;
  urlTo?: string;
  elementsAppeared: number;
  elementsDisappeared: number;
  newRoles: Record<string, number>;       // role → count of new elements with that role
  newHeadings: string[];                  // headings that appeared
  newDialogs: string[];                   // dialog-like text that appeared
  formFieldsChanged: string[];            // field names only (never values)
  summary: string;                        // plain-language one-liner
}

export function snapshotObservation(obs: Observation, sensitiveNames: string[] = []): WindowSnapshot {
  const frameCounts: Record<string, number> = {};
  for (const el of obs.elements) {
    frameCounts[el.frame] = (frameCounts[el.frame] || 0) + 1;
  }
  const headings = obs.elements
    .filter(e => e.role === 'heading' && e.name.length > 0)
    .map(e => e.name.substring(0, 50));
  const dialogTexts = obs.elements
    .filter(e => e.role === 'dialog' || (e.role === 'heading' && e.name.toLowerCase().includes('error')))
    .map(e => e.name.substring(0, 50));
  // Form field names (attrName), masking sensitive ones
  const formFieldNames = obs.elements
    .filter(e => ['textbox', 'combobox', 'checkbox'].includes(e.role) && e.attrName)
    .map(e => sensitiveNames.includes(e.attrName!) ? `${e.attrName} [sensitive]` : e.attrName!);

  return {
    url: obs.url,
    elementCount: obs.elements.length,
    frameElementCounts: frameCounts,
    headings,
    dialogTexts,
    formFieldNames: [...new Set(formFieldNames)],
  };
}

export function diffSnapshots(before: WindowSnapshot, after: WindowSnapshot): HumanActionsDiff {
  const urlChanged = before.url !== after.url;
  const elementsAppeared = Math.max(0, after.elementCount - before.elementCount);
  const elementsDisappeared = Math.max(0, before.elementCount - after.elementCount);

  // New headings
  const beforeHeadingsSet = new Set(before.headings);
  const newHeadings = after.headings.filter(h => !beforeHeadingsSet.has(h));

  // New dialogs
  const beforeDialogsSet = new Set(before.dialogTexts);
  const newDialogs = after.dialogTexts.filter(d => !beforeDialogsSet.has(d));

  // Changed form fields (fields present in after but not before, or vice versa)
  const beforeFields = new Set(before.formFieldNames);
  const afterFields = new Set(after.formFieldNames);
  const formFieldsChanged = [...afterFields].filter(f => !beforeFields.has(f));

  // New element roles
  const newRoles: Record<string, number> = {};
  // Approximate by comparing frame counts
  for (const [frame, count] of Object.entries(after.frameElementCounts)) {
    const beforeCount = before.frameElementCounts[frame] || 0;
    if (count > beforeCount) {
      newRoles[frame] = count - beforeCount;
    }
  }

  // Build summary
  const parts: string[] = [];
  if (urlChanged) parts.push(`navigated from ${before.url} to ${after.url}`);
  if (newHeadings.length > 0) parts.push(`new heading: "${newHeadings[0]}"`);
  if (newDialogs.length > 0) parts.push(`new dialog: "${newDialogs[0]}"`);
  if (elementsAppeared > 5) parts.push(`${elementsAppeared} elements appeared`);
  if (elementsDisappeared > 5) parts.push(`${elementsDisappeared} elements disappeared`);
  if (formFieldsChanged.length > 0) parts.push(`form fields changed: ${formFieldsChanged.join(', ')}`);

  const summary = parts.length > 0 ? parts.join('; ') : 'no observable change';

  return {
    urlChanged, urlFrom: urlChanged ? before.url : undefined, urlTo: urlChanged ? after.url : undefined,
    elementsAppeared, elementsDisappeared,
    newRoles, newHeadings, newDialogs, formFieldsChanged,
    summary,
  };
}
