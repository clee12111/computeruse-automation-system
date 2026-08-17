// src/surface/browser-surface.ts — Playwright implementation of Surface.
// DESIGN_MAP D2: perceive rich, act semantic, resolve with fallbacks.
// No CSS selectors or XPath stored in descriptors — rungs hold semantic fields;
// Playwright locators are derived from those fields at resolve time.

import { chromium, type Browser, type BrowserContext, type Page, type Frame, type Locator } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Descriptor, Predicate, PropertySet } from '../schema/artifact.js';
import type {
  Surface, SurfaceConfig, Observation, ElementInfo,
  ResolveResult, RungReport, ActResult, PolicyViolation,
} from './surface.js';
import { checkPolicy } from '../guardrails/policy.js';
import { resolveByScoring } from './scoring.js';

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
  private lastScoringResult: { topScore: number; margin: number; matchedRole?: string; candidates?: any[] } | null = null;
  private refCounter = 0;
  private ssCounter = 0;

  constructor(config: SurfaceConfig) {
    this.config = config;
  }

  getBaseUrl(): string {
    return this.config.baseUrl;
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
      const furl = frame.url();
      try {
        // Use evaluateHandle + JSON to avoid tsx __name transform breaking in-browser code
        const handle = await frame.evaluateHandle(`(() => {
          function computeAccessibleName(el) {
            var labelledBy = el.getAttribute('aria-labelledby');
            if (labelledBy) {
              var parts = labelledBy.split(/\\s+/).map(function(id) {
                var ref = document.getElementById(id);
                return ref ? (ref.textContent || '').trim() : '';
              }).filter(Boolean);
              if (parts.length > 0) return parts.join(' ');
            }
            var ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
            var tag = el.tagName.toLowerCase();
            if (tag === 'input' || tag === 'select' || tag === 'textarea') {
              var id = el.getAttribute('id');
              if (id) {
                var label = document.querySelector('label[for="' + id + '"]');
                if (label) return (label.textContent || '').trim();
              }
              var ancestorLabel = el.closest('label');
              if (ancestorLabel) {
                var clone = ancestorLabel.cloneNode(true);
                var selfInClone = clone.querySelector(tag);
                if (selfInClone) selfInClone.remove();
                var labelText = (clone.textContent || '').trim();
                if (labelText) return labelText;
              }
            }
            var type = el.getAttribute('type') || '';
            if (tag === 'input' && ['submit', 'button', 'reset'].indexOf(type) >= 0) {
              var val = el.value;
              if (val && val.trim()) return val.trim();
              if (type === 'submit') return 'Submit';
              if (type === 'reset') return 'Reset';
            }
            if (tag === 'img') {
              var alt = el.getAttribute('alt');
              if (alt != null) return alt.trim();
            }
            if (tag === 'button') {
              var text = (el.textContent || '').trim();
              if (text) return text;
            }
            var title = el.getAttribute('title');
            if (title && title.trim()) return title.trim();
            if (tag === 'input' || tag === 'textarea') {
              var ph = el.getAttribute('placeholder');
              if (ph && ph.trim()) return ph.trim();
            }
            return (el.textContent || '').trim();
          }
          function normalizeHeader(raw) {
            return raw.replace(/\\s+/g, ' ').replace(/[*†‡]+$/, '').trim();
          }
          var interactiveSelectors = 'a, button, input, select, textarea, [role], td, th';
          var els = Array.from(document.querySelectorAll(interactiveSelectors));
          return JSON.stringify(els.map(function(el) {
            var tag = el.tagName.toLowerCase();
            var type = el.getAttribute('type') || '';
            var ariaRole = el.getAttribute('role') || '';
            var accName = computeAccessibleName(el);
            var rect = el.getBoundingClientRect();
            var nearbyText = '';
            var columnHeader = '';
            var row = el.closest('tr');
            if (row) {
              var cells = Array.from(row.querySelectorAll('td, th'));
              var myCell = el.closest('td, th');
              var myIdx = cells.indexOf(myCell);
              for (var ci = 0; ci < cells.length; ci++) {
                if (cells[ci] !== myCell && cells[ci].textContent && cells[ci].textContent.trim()) {
                  nearbyText = cells[ci].textContent.trim().substring(0, 80);
                  break;
                }
              }
              if (myIdx >= 0 && (tag === 'td' || tag === 'th')) {
                var table = el.closest('table');
                if (table) {
                  var headerRow = table.querySelector('tr');
                  if (headerRow && headerRow !== row) {
                    var headers = Array.from(headerRow.querySelectorAll('th, td'));
                    if (headers[myIdx]) {
                      var rawH = headers[myIdx].textContent ? headers[myIdx].textContent.trim() : '';
                      columnHeader = normalizeHeader(rawH).substring(0, 30);
                    }
                  }
                }
              }
            }
            var options;
            if (tag === 'select') {
              options = Array.from(el.options).map(function(o) { return o.text.trim() || o.value; });
            }
            var htmlName = el.getAttribute('name') || '';
            var htmlId = el.getAttribute('id') || '';
            var attrName = htmlName || htmlId || '';
            return {
              tag: tag, type: type, ariaRole: ariaRole, accName: accName,
              nearbyText: nearbyText, columnHeader: columnHeader, attrName: attrName,
              value: el.value || '', options: options,
              x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            };
          }));
        })()`);
        const itemsJson = await handle.jsonValue() as string;
        await handle.dispose();
        const items: Array<{
          tag: string; type: string; ariaRole: string; accName: string;
          nearbyText: string; columnHeader: string; attrName: string;
          value: string; options?: string[];
          x: number; y: number; width: number; height: number;
        }> = JSON.parse(itemsJson);

        for (const item of items) {
          if (item.width === 0 && item.height === 0) continue; // hidden
          const ref = `e${this.refCounter++}`;
          const role = item.ariaRole || implicitRole(item.tag, item.type || undefined);
          const name = item.accName || '';
          elements.push({
            ref, role, name: name.substring(0, 100),
            nearbyText: item.nearbyText || undefined,
            columnHeader: item.columnHeader || undefined,
            frame: fname,
            frameUrl: furl !== 'about:blank' ? furl : undefined,
            attrName: item.attrName || undefined,
            value: item.value || undefined,
            options: item.options,
            bounds: { x: item.x, y: item.y, width: item.width, height: item.height },
          });
          this.elementMap.set(ref, { frame: fname, locatorDesc: `${role}:${name.substring(0, 50)}` });
        }
      } catch (err) {
        // Frame may not be ready — skip. Log for debugging.
        if (process.env.DEBUG_OBSERVE) console.error(`observe() frame error (${fname}):`, err);
      }
    }

    // observe_degraded: warn if all frames failed (0 elements observed)
    if (elements.length === 0) {
      console.error('[observe_degraded] WARNING: observe() returned 0 elements — all frame evaluations may have failed');
    }

    this.lastObservation = {
      url: page.url(),
      title: await page.title(),
      screenshotPath,
      elements,
    };
    return this.lastObservation;
  }

  // ── describe(ref) — v2: emit property set ─────────────────

  async describe(ref: string): Promise<Descriptor[]> {
    const obs = this.lastObservation ?? await this.observe();
    const el = obs.elements.find(e => e.ref === ref);
    if (!el) return [];

    // Build property set from observed element
    const props: PropertySet = {
      role: el.role,
      frame: el.frame,
    };

    if (el.name && el.name.trim().length > 0) props.name = el.name;
    if (el.attrName) props.attrName = el.attrName;
    if (el.columnHeader) props.columnHeader = el.columnHeader;
    if (el.nearbyText) props.neighborText = el.nearbyText.split(/\s+/).filter(Boolean);
    if (el.bounds) {
      props.position = {
        x: Math.round(el.bounds.x + el.bounds.width / 2),
        y: Math.round(el.bounds.y + el.bounds.height / 2),
      };
      props.size = {
        w: Math.round(el.bounds.width),
        h: Math.round(el.bounds.height),
      };
    }

    // Return as single-element array for interface compat
    return [props];
  }

  // ── resolve(props) — v2: similarity scoring ───────────────

  async resolve(chain: Descriptor[]): Promise<ResolveResult> {
    if (chain.length === 0) return { kind: 'notFound', rungReports: [] };

    const props = chain[0] as PropertySet;
    const obs = await this.observe();

    const result = resolveByScoring(props, obs.elements);

    // Store scoring metadata for telemetry
    this.lastScoringResult = result.topScore != null
      ? { topScore: result.topScore, margin: result.margin ?? 0, matchedRole: props.role,
          candidates: result.candidates?.slice(0, 3).map(c => ({ score: c.score, breakdown: c.breakdown })) }
      : null;

    if (result.kind === 'match' && result.ref) {
      // Store a locator for act() — find element by its observed properties
      const matchedEl = obs.elements.find(e => e.ref === result.ref);
      if (matchedEl) {
        const frame = this.findFrame(matchedEl.frame);
        if (frame) {
          const locator = await this.buildLocatorForElement(matchedEl, frame);
          if (locator) {
            const resolvedRef = `r${this.refCounter++}`;
            this.elementMap.set(resolvedRef, { frame: matchedEl.frame, locatorDesc: `scored:${result.topScore?.toFixed(2)}` });
            this.resolvedLocators.set(resolvedRef, locator);
            return { kind: 'match', ref: resolvedRef, rungIndex: 0 };
          }
        }
      }
      return { kind: 'notFound', rungReports: [] };
    }

    if (result.kind === 'ambiguous') {
      return {
        kind: 'ambiguous',
        rungReports: (result.candidates ?? []).map((c, i) => ({
          rungIndex: i,
          descriptor: props,
          count: result.candidates?.length ?? 0,
          reason: `score=${c.score.toFixed(2)} margin=${result.margin?.toFixed(3)}`,
        })),
      };
    }

    return { kind: 'notFound', rungReports: [] };
  }

  /** Build a Playwright Locator for a matched element using its observed properties. */
  private async buildLocatorForElement(el: ElementInfo, frame: Frame): Promise<Locator | null> {
    try {
      // Prefer role+name for interactive elements
      if (el.name && el.role !== 'cell' && el.role !== 'columnheader') {
        const loc = frame.getByRole(el.role as any, { name: el.name, exact: true });
        if (await loc.count() === 1) return loc.first();
      }

      // For cells: locate by text content within td/th
      if ((el.role === 'cell' || el.role === 'columnheader') && el.name) {
        // Use bounds-based matching for precise identification
        if (el.bounds) {
          const idx = await frame.evaluate(({ text, bx, by }) => {
            const cells = Array.from(document.querySelectorAll('td, th'));
            for (let i = 0; i < cells.length; i++) {
              const r = cells[i].getBoundingClientRect();
              if (Math.abs(r.x - bx) < 2 && Math.abs(r.y - by) < 2) return i;
            }
            return -1;
          }, { text: el.name, bx: el.bounds.x, by: el.bounds.y });
          if (idx >= 0) return frame.locator('td, th').nth(idx);
        }
      }

      // Fallback: textbox by position in frame
      if (el.role === 'textbox' && el.bounds) {
        const loc = frame.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea');
        const count = await loc.count();
        for (let i = 0; i < count; i++) {
          const box = await loc.nth(i).boundingBox();
          if (box && Math.abs(box.x - el.bounds.x) < 5 && Math.abs(box.y - el.bounds.y) < 5) {
            return loc.nth(i);
          }
        }
      }

      // General fallback: by bounds
      if (el.bounds) {
        const selector = el.role === 'button' ? 'button, input[type="submit"], input[type="button"]'
          : el.role === 'link' ? 'a'
          : el.role === 'combobox' ? 'select'
          : el.role === 'checkbox' ? 'input[type="checkbox"]'
          : 'a, button, input, select, textarea, td, th, [role]';
        const loc = frame.locator(selector);
        const count = await loc.count();
        for (let i = 0; i < count; i++) {
          const box = await loc.nth(i).boundingBox();
          if (box && Math.abs(box.x - el.bounds.x) < 5 && Math.abs(box.y - el.bounds.y) < 5) {
            return loc.nth(i);
          }
        }
      }
    } catch { /* Locator building failure — return null */ }
    return null;
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
          // Wait for all frames to settle (framesets: click in nav frame updates content frame)
          await Promise.all(this.allFrames().map(f =>
            f.waitForLoadState('domcontentloaded').catch(() => {})
          ));
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
          try {
            await locator.selectOption(String(action.value ?? ''), { timeout: 3000 });
          } catch (e) {
            // Fast-fail with available options listed
            const availableOpts = await locator.evaluate((el: HTMLSelectElement) =>
              Array.from(el.options).map(o => o.value || o.text).join(', ')
            ).catch(() => '(could not read options)');
            return { ok: false, error: `selectOption failed for "${action.value}". Available: [${availableOpts}]` };
          }
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
