// src/surface/browser-surface.ts — Playwright implementation of Surface.
// DESIGN_MAP D2: perceive rich, act semantic, resolve with fallbacks.
// No CSS selectors or XPath stored in descriptors — rungs hold semantic fields;
// Playwright locators are derived from those fields at resolve time.

import { chromium, type Browser, type BrowserContext, type Page, type Frame, type Locator } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Descriptor, Predicate } from '../schema/artifact.js';
import type {
  Surface, SurfaceConfig, Observation, ElementInfo,
  ResolveResult, RungReport, ActResult, PolicyViolation,
} from './surface.js';
import { checkPolicy } from '../guardrails/policy.js';

// ── Helpers ─────────────────────────────────────────────────

// Map HTML elements to ARIA roles
function implicitRole(tag: string, type?: string): string {
  const t = tag.toLowerCase();
  if (t === 'button') return 'button';
  if (t === 'a') return 'link';
  if (t === 'select') return 'combobox';
  if (t === 'textarea') return 'textbox';
  if (t === 'input') {
    if (!type || type === 'text' || type === 'password' || type === 'search' || type === 'email' || type === 'tel' || type === 'url') return 'textbox';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    return 'textbox';
  }
  if (t === 'table') return 'table';
  if (t === 'th') return 'columnheader';
  if (t === 'td') return 'cell';
  if (t === 'tr') return 'row';
  if (t === 'img') return 'img';
  if (t === 'h1' || t === 'h2' || t === 'h3' || t === 'h4') return 'heading';
  return t;
}

// ── BrowserSurface ──────────────────────────────────────────

export class BrowserSurface implements Surface {
  private config: SurfaceConfig;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private elementMap = new Map<string, { frame: string; locatorDesc: string }>();
  private resolvedLocators = new Map<string, Locator>();
  private lastObservation: Observation | null = null;
  private refCounter = 0;
  private ssCounter = 0;

  constructor(config: SurfaceConfig) {
    this.config = config;
  }

  async launch(): Promise<void> {
    this.browser = await chromium.launch({ headless: !this.config.headed });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 900 } });
    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    await this.page?.close();
    await this.context?.close();
    await this.browser?.close();
  }

  private getPage(): Page {
    if (!this.page) throw new Error('Surface not launched');
    return this.page;
  }

  private allFrames(): Frame[] {
    const page = this.getPage();
    return [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];
  }

  private frameName(frame: Frame): string {
    const page = this.getPage();
    return frame === page.mainFrame() ? 'main' : (frame.name() || frame.url().split('/').pop() || 'iframe');
  }

  // ── observe() ───────────────────────────────────────────

  async observe(): Promise<Observation> {
    const page = this.getPage();
    let screenshotPath: string | undefined;
    if (this.config.screenshotDir) {
      mkdirSync(this.config.screenshotDir, { recursive: true });
      screenshotPath = join(this.config.screenshotDir, `obs-${this.ssCounter++}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    this.elementMap.clear();
    this.refCounter = 0;
    const elements: ElementInfo[] = [];

    for (const frame of this.allFrames()) {
      const fname = this.frameName(frame);
      try {
        const items = await frame.evaluate(() => {
          const interactiveSelectors = 'a, button, input, select, textarea, [role], td, th';
          const els = Array.from(document.querySelectorAll(interactiveSelectors));
          return els.map(el => {
            const tag = el.tagName.toLowerCase();
            const type = el.getAttribute('type') || '';
            const ariaRole = el.getAttribute('role') || '';
            const ariaLabel = el.getAttribute('aria-label') || '';
            const text = (el.textContent || '').trim().substring(0, 100);
            const rect = el.getBoundingClientRect();
            // Find nearest label-like text (parent's text minus our own text)
            let nearbyText = '';
            let columnHeader = '';
            const row = el.closest('tr');
            if (row) {
              const cells = Array.from(row.querySelectorAll('td, th'));
              const myCell = el.closest('td, th');
              const myIdx = cells.indexOf(myCell as HTMLElement);
              for (const c of cells) {
                if (c !== myCell && c.textContent?.trim()) {
                  nearbyText = c.textContent.trim().substring(0, 80);
                  break;
                }
              }
              // Find column header for this cell
              if (myIdx >= 0 && (tag === 'td' || tag === 'th')) {
                const table = el.closest('table');
                if (table) {
                  const headerRow = table.querySelector('tr');
                  if (headerRow && headerRow !== row) {
                    const headers = Array.from(headerRow.querySelectorAll('th, td'));
                    if (headers[myIdx]) {
                      columnHeader = headers[myIdx].textContent?.trim()?.substring(0, 30) || '';
                    }
                  }
                }
              }
            }
            return {
              tag, type, ariaRole, ariaLabel, text, nearbyText, columnHeader,
              value: (el as HTMLInputElement).value || '',
              x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            };
          });
        });

        for (const item of items) {
          if (item.width === 0 && item.height === 0) continue; // hidden
          const ref = `e${this.refCounter++}`;
          const role = item.ariaRole || implicitRole(item.tag, item.type || undefined);
          const name = item.ariaLabel || item.text || '';
          elements.push({
            ref, role, name: name.substring(0, 100),
            nearbyText: item.nearbyText || undefined,
            columnHeader: item.columnHeader || undefined,
            frame: fname,
            value: item.value || undefined,
            bounds: { x: item.x, y: item.y, width: item.width, height: item.height },
          });
          this.elementMap.set(ref, { frame: fname, locatorDesc: `${role}:${name.substring(0, 50)}` });
        }
      } catch {
        // Frame may not be ready — skip
      }
    }

    this.lastObservation = {
      url: page.url(),
      title: await page.title(),
      screenshotPath,
      elements,
    };
    return this.lastObservation;
  }

  // ── describe(ref) ─────────────────────────────────────────

  async describe(ref: string): Promise<Descriptor[]> {
    // Use cached observation to preserve ref stability; re-observe only if needed
    const obs = this.lastObservation ?? await this.observe();
    const el = obs.elements.find(e => e.ref === ref);
    if (!el) return [];

    const chain: Descriptor[] = [];

    // Strategy 1: roleName (skip td/th — a cell's accessible name is its DATA, not identity)
    if (el.name && el.name.length > 1 && el.role && el.role !== 'cell' && el.role !== 'columnheader') {
      const candidate: Descriptor = { by: 'roleName' as const, role: el.role, name: el.name };
      const verified = await this.resolve([candidate]);
      if (verified.kind === 'match') chain.push(candidate);
    }

    // Strategy 2: labelProximity (if nearby label text exists)
    if (el.nearbyText && el.role) {
      const candidate: Descriptor = { by: 'labelProximity' as const, role: el.role, anchor: el.nearbyText };
      const verified = await this.resolve([candidate]);
      if (verified.kind === 'match') chain.push(candidate);
    }

    // Strategy 3: tableCell (if element is inside a table with headers)
    const tableCellDesc = await this.tryTableCellDescriptor(el);
    if (tableCellDesc) {
      const verified = await this.resolve([tableCellDesc]);
      if (verified.kind === 'match') chain.push(tableCellDesc);
    }

    // Strategy 4: structural (positional description)
    const structuralDesc = await this.tryStructuralDescriptor(el, obs);
    if (structuralDesc) {
      const verified = await this.resolve([structuralDesc]);
      if (verified.kind === 'match') chain.push(structuralDesc);
    }

    // Strategy 5: geometric (always lastResort)
    if (el.bounds) {
      chain.push({
        by: 'geometric' as const,
        lastResort: true as const,
        x: Math.round(el.bounds.x + el.bounds.width / 2),
        y: Math.round(el.bounds.y + el.bounds.height / 2),
      } as Descriptor);
    }

    return chain;
  }

  private async tryTableCellDescriptor(el: ElementInfo): Promise<Descriptor | null> {
    // Only works for elements inside table cells
    const frame = this.findFrame(el.frame);
    if (!frame) return null;
    try {
      const info = await frame.evaluate((elText) => {
        // Find cells containing this text
        const cells = Array.from(document.querySelectorAll('td'));
        for (const cell of cells) {
          if (!cell.textContent?.includes(elText)) continue;
          const row = cell.closest('tr');
          const table = cell.closest('table');
          if (!row || !table) continue;
          // Find column index
          const allCells = Array.from(row.querySelectorAll('td, th'));
          const colIndex = allCells.indexOf(cell);
          if (colIndex < 0) continue;
          // Find header for this column
          const headerRow = table.querySelector('tr');
          if (!headerRow) continue;
          const headers = Array.from(headerRow.querySelectorAll('th, td'));
          const header = headers[colIndex]?.textContent?.trim() || '';
          // Sane header: single line, ≤40 chars; else skip (probably a layout table, not data)
          if (!header || header.includes('\n') || header.length > 40) continue;
          // Find row identifier — prefer distinctive text (non-numeric, non-ID-shaped)
          const rowTexts = allCells.filter((_, i) => i !== colIndex)
            .map(c => c.textContent?.trim() || '').filter(t => t.length > 0);
          // Score: prefer non-numeric words like "Savings", "Checking" over IDs like "00", "12345-S1"
          const scored = rowTexts.map(t => ({ t, score: /^[a-zA-Z]/.test(t) && !/^\d/.test(t) ? 2 : /^[0-9]{1,3}$/.test(t) ? 0 : 1 }));
          scored.sort((a, b) => b.score - a.score);
          const rowContains = scored[0]?.t || rowTexts[0] || '';
          return { column: header, rowContains };
        }
        return null;
      }, el.name || el.value || '');
      if (info) {
        return { by: 'tableCell' as const, column: info.column, rowContains: info.rowContains };
      }
    } catch { /* ignore */ }
    return null;
  }

  private async tryStructuralDescriptor(el: ElementInfo, obs: Observation): Promise<Descriptor | null> {
    // Count how many elements of the same role exist in the same frame
    const sameRole = obs.elements.filter(e => e.role === el.role && e.frame === el.frame);
    if (sameRole.length === 1) {
      return { by: 'structural' as const, note: `only ${el.role} in ${el.frame}` };
    }
    const index = sameRole.indexOf(el);
    if (index >= 0) {
      return { by: 'structural' as const, note: `${el.role} #${index + 1} of ${sameRole.length} in ${el.frame}` };
    }
    return null;
  }

  // ── resolve(chain) ────────────────────────────────────────

  async resolve(chain: Descriptor[]): Promise<ResolveResult> {
    const rungReports: RungReport[] = [];
    let hasAmbiguous = false;

    for (let i = 0; i < chain.length; i++) {
      const desc = chain[i];
      let totalCount = 0;
      let matchRef: string | null = null;

      for (const frame of this.allFrames()) {
        const fname = this.frameName(frame);
        try {
          const { count, ref } = await this.resolveRungInFrame(desc, frame, fname);
          totalCount += count;
          if (count === 1 && !matchRef) matchRef = ref;
        } catch {
          // Frame error — count as 0
        }
      }

      if (totalCount === 1 && matchRef) {
        return { kind: 'match', ref: matchRef, rungIndex: i };
      }

      const reason = totalCount === 0
        ? 'not found'
        : `ambiguous (${totalCount} matches)`;
      if (totalCount > 1) hasAmbiguous = true;
      rungReports.push({ rungIndex: i, descriptor: desc, count: totalCount, reason });
    }

    return { kind: hasAmbiguous ? 'ambiguous' : 'notFound', rungReports };
  }

  // Map semantic role to Playwright locator — handles textbox specially
  // (Playwright's getByRole('textbox') misses input[type=password])
  private roleLocator(container: Locator | Frame, role: string): Locator {
    if (role === 'textbox') {
      return container.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea');
    }
    if (role === 'cell' || role === 'columnheader') {
      return container.locator('td, th');
    }
    if ('getByRole' in container && typeof container.getByRole === 'function') {
      return container.getByRole(role as any);
    }
    return (container as Locator).getByRole(role as any);
  }

  private async resolveRungInFrame(
    desc: Descriptor, frame: Frame, fname: string,
  ): Promise<{ count: number; ref: string | null }> {
    let locator: Locator;

    switch (desc.by) {
      case 'roleName': {
        if (desc.role === 'cell' || desc.role === 'columnheader') {
          // Playwright's getByRole doesn't match td/th; use locator with text filter
          locator = frame.locator('td, th').filter({ hasText: desc.name });
        } else {
          locator = frame.getByRole(desc.role as any, { name: desc.name, exact: true });
        }
        break;
      }
      case 'labelProximity': {
        // Find the exact label text element, go to its closest ancestor TR, find the role within.
        // Using exact text matching avoids hitting outer layout cells that contain the text as a descendant.
        const textEl = frame.getByText(desc.anchor, { exact: true });
        const parentRow = textEl.locator('xpath=ancestor::tr[1]');
        locator = this.roleLocator(parentRow, desc.role);
        break;
      }
      case 'tableCell': {
        // Find cells by column header + row text; count matches and get the element
        const result = await frame.evaluate(({ column, rowContains }) => {
          const tables = Array.from(document.querySelectorAll('table'));
          const matches: { tableIdx: number; rowIdx: number; colIdx: number }[] = [];
          tables.forEach((table, ti) => {
            const headerRow = table.querySelector('tr');
            if (!headerRow) return;
            const headers = Array.from(headerRow.querySelectorAll('th, td'));
            const colIndex = headers.findIndex(h => h.textContent?.trim() === column);
            if (colIndex < 0) return;
            const rows = Array.from(table.querySelectorAll('tr')).slice(1);
            rows.forEach((row, ri) => {
              if (!row.textContent?.includes(rowContains)) return;
              const cells = Array.from(row.querySelectorAll('td, th'));
              if (cells[colIndex]) matches.push({ tableIdx: ti, rowIdx: ri + 1, colIdx: colIndex });
            });
          });
          return matches;
        }, { column: desc.column, rowContains: desc.rowContains });

        if (result.length === 1) {
          const m = result[0];
          // Build a locator to the matched cell
          const cellLocator = frame.locator(`table`).nth(m.tableIdx)
            .locator('tr').nth(m.rowIdx).locator('td, th').nth(m.colIdx);
          const ref = `r${this.refCounter++}`;
          this.elementMap.set(ref, { frame: fname, locatorDesc: `tableCell:${desc.column}/${desc.rowContains}` });
          this.resolvedLocators.set(ref, cellLocator);
          return { count: 1, ref };
        }
        return { count: result.length, ref: null };
      }
      case 'anchorRelation': {
        // Find elements matching 'match' near the 'anchor' text with given 'relation'
        const containers = frame.locator('tr, div, td').filter({ hasText: desc.anchor });
        locator = containers.locator(`text=/${desc.match}/i`);
        break;
      }
      case 'structural': {
        // Parse the note for positional info
        const match = desc.note.match(/^only (\w+) in (.+)$/);
        if (match) {
          locator = this.roleLocator(frame, match[1]);
          if (this.frameName(frame) !== match[2]) return { count: 0, ref: null };
        } else {
          const posMatch = desc.note.match(/^(\w+) #(\d+) of (\d+) in (.+)$/);
          if (posMatch && this.frameName(frame) === posMatch[4]) {
            const role = posMatch[1];
            const idx = parseInt(posMatch[2], 10) - 1;
            locator = this.roleLocator(frame, role).nth(idx);
            const total = await this.roleLocator(frame, role).count();
            if (total === parseInt(posMatch[3], 10)) {
              const ref = `r${this.refCounter++}`;
              this.elementMap.set(ref, { frame: this.frameName(frame), locatorDesc: `structural:${desc.note}` });
              this.resolvedLocators.set(ref, locator);
              return { count: 1, ref };
            }
            return { count: 0, ref: null };
          }
          return { count: 0, ref: null };
        }
        break;
      }
      case 'geometric': {
        // Find element at coordinates (x, y)
        const geo = desc as Descriptor & { x?: number; y?: number };
        if (geo.x != null && geo.y != null) {
          const el = await frame.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            return el ? true : false;
          }, { x: geo.x, y: geo.y });
          if (el) {
            const ref = `r${this.refCounter++}`;
            this.elementMap.set(ref, { frame: fname, locatorDesc: `geometric:${geo.x},${geo.y}` });
            return { count: 1, ref };
          }
        }
        return { count: 0, ref: null };
      }
      default:
        return { count: 0, ref: null };
    }

    const count = await locator.count();
    if (count === 1) {
      const ref = `r${this.refCounter++}`;
      this.elementMap.set(ref, { frame: fname, locatorDesc: `${desc.by}:resolved` });
      this.resolvedLocators.set(ref, locator.first());
      return { count, ref };
    }
    return { count, ref: null };
  }

  private findFrame(fname: string): Frame | null {
    for (const f of this.allFrames()) {
      if (this.frameName(f) === fname) return f;
    }
    return null;
  }

  // ── check(predicate) ──────────────────────────────────────

  async check(predicate: Predicate): Promise<boolean> {
    const page = this.getPage();
    const p = predicate as Record<string, unknown>;

    if ('textPresent' in p) {
      for (const frame of this.allFrames()) {
        try { if (await frame.getByText(p.textPresent as string, { exact: false }).count() > 0) return true; } catch {}
      }
      return false;
    }
    if ('textAbsent' in p) {
      for (const frame of this.allFrames()) {
        try { if (await frame.getByText(p.textAbsent as string, { exact: false }).count() > 0) return false; } catch {}
      }
      return true;
    }
    if ('elementPresent' in p) {
      for (const frame of this.allFrames()) {
        try { if (await frame.locator(p.elementPresent as string).count() > 0) return true; } catch {}
      }
      return false;
    }
    if ('dialogPresent' in p) {
      // Check for visible text matching the dialog description
      for (const frame of this.allFrames()) {
        try { if (await frame.getByText(p.dialogPresent as string, { exact: false }).count() > 0) return true; } catch {}
      }
      return false;
    }
    if ('urlMatches' in p) {
      return page.url().includes(p.urlMatches as string);
    }
    if ('outputPopulated' in p) {
      // This is checked by the replay engine, not the Surface directly
      return false;
    }
    if ('elementValue' in p) {
      // Deferred to engine context
      return false;
    }
    if ('anyOf' in p) {
      for (const sub of p.anyOf as Predicate[]) {
        if (await this.check(sub)) return true;
      }
      return false;
    }
    if ('allOf' in p) {
      for (const sub of p.allOf as Predicate[]) {
        if (!(await this.check(sub))) return false;
      }
      return true;
    }
    if ('$outcome' in p) {
      // Outcome checking is engine-level, not Surface-level
      return false;
    }
    return false;
  }

  // ── act() ─────────────────────────────────────────────────

  async act(action: { verb: string; value?: unknown; ref?: string }): Promise<ActResult> {
    const page = this.getPage();
    const currentUrlStr = page.url();

    // Guardrails: check policy (skip origin check for about:blank)
    if (currentUrlStr && currentUrlStr !== 'about:blank') {
      const currentUrl = new URL(currentUrlStr);
      const violation = checkPolicy(
        this.config.policy,
        currentUrl.origin,
        currentUrl.pathname,
        action.verb,
      );
      if (violation) return { ok: false, blocked: violation };
    }

    try {
      switch (action.verb) {
        case 'click': {
          if (!action.ref) return { ok: false, error: 'click requires a ref' };
          const locator = await this.refToLocator(action.ref);
          if (!locator) return { ok: false, error: `ref ${action.ref} not found` };
          await locator.click();
          return { ok: true };
        }
        case 'type': {
          if (!action.ref) return { ok: false, error: 'type requires a ref' };
          const locator = await this.refToLocator(action.ref);
          if (!locator) return { ok: false, error: `ref ${action.ref} not found` };
          await locator.fill(String(action.value ?? ''));
          return { ok: true };
        }
        case 'select': {
          if (!action.ref) return { ok: false, error: 'select requires a ref' };
          const locator = await this.refToLocator(action.ref);
          if (!locator) return { ok: false, error: `ref ${action.ref} not found` };
          await locator.selectOption(String(action.value ?? ''));
          return { ok: true };
        }
        case 'read': {
          if (!action.ref) return { ok: false, error: 'read requires a ref' };
          const locator = await this.refToLocator(action.ref);
          if (!locator) return { ok: false, error: `ref ${action.ref} not found` };
          const text = await locator.textContent() ?? '';
          return { ok: true, readValue: text.trim() };
        }
        case 'navigate': {
          return this.navigate(String(action.value ?? ''));
        }
        default:
          return { ok: false, error: `unknown verb: ${action.verb}` };
      }
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async navigate(path: string): Promise<ActResult> {
    const page = this.getPage();
    const fullUrl = path.startsWith('http')
      ? path
      : `${this.config.baseUrl}${this.config.tenantPrefix}${path}`;

    // Guardrails: check policy for the TARGET url
    const targetUrl = new URL(fullUrl);
    const violation = checkPolicy(
      this.config.policy,
      targetUrl.origin,
      targetUrl.pathname,
      'navigate',
    );
    if (violation) return { ok: false, blocked: violation };

    try {
      await page.goto(fullUrl, { waitUntil: 'load' });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // ── Internal helpers ──────────────────────────────────────

  private async refToLocator(ref: string): Promise<Locator | null> {
    // Use stored Locator from resolve() — never re-derive from descriptor
    return this.resolvedLocators.get(ref) ?? null;
  }
}
