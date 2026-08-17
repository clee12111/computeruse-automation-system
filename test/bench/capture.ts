// test/bench/capture.ts — One-time fixture capture. RUN_CAPTURE=1 to execute.
// Navigates to live pages, stamps every element with data-bench-id, saves HTML.
// For iframe/frame pages, saves each frame document separately.
//
// Usage: npx tsx test/bench/capture.ts

import { chromium, type Page, type Frame } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.RUN_CAPTURE !== '1') {
  console.log('Capture gated. Set RUN_CAPTURE=1 to run.');
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = resolve(__dirname, '../fixtures');

interface PageSpec {
  site: string;
  page: string;
  url: string;
  setup?: (page: Page) => Promise<void>;
  hasIframes?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────

async function stampElements(frame: Frame): Promise<number> {
  return frame.evaluate(() => {
    let id = 0;
    const selector = 'a, button, input, select, textarea, [role], td, th, h1, h2, h3, h4, label, img, option';
    const els = document.querySelectorAll(selector);
    els.forEach(el => {
      el.setAttribute('data-bench-id', `bid-${id++}`);
    });
    return id;
  });
}

async function captureFrame(frame: Frame, dir: string, filename: string): Promise<number> {
  const count = await stampElements(frame);
  const html = await frame.evaluate(() => {
    return '<!DOCTYPE html>' + document.documentElement.outerHTML;
  });
  writeFileSync(join(dir, filename), html, 'utf8');
  return count;
}

async function capturePage(page: Page, spec: PageSpec): Promise<void> {
  const dir = join(FIXTURES_DIR, spec.site, spec.page);
  mkdirSync(dir, { recursive: true });

  // Caller is responsible for navigation. We just wait for iframes to settle.
  await page.waitForTimeout(2000);

  // Stamp main frame
  const mainCount = await stampElements(page.mainFrame());

  // Capture iframes/frames
  const childFrames = page.frames().filter(f => f !== page.mainFrame());
  let iframeIndex = 0;
  const iframeSrcMap: Map<string, string> = new Map();

  for (const frame of childFrames) {
    const frameUrl = frame.url();
    if (frameUrl === 'about:blank') continue;
    const iframeFile = `iframe-${iframeIndex}.html`;
    const count = await captureFrame(frame, dir, iframeFile);
    iframeSrcMap.set(frameUrl, iframeFile);
    console.log(`  iframe ${iframeIndex}: ${count} elements stamped (${frameUrl})`);
    iframeIndex++;
  }

  // For the main frame, rewrite iframe src attributes to point to local files
  const mainHtml = await page.evaluate((srcMap) => {
    const iframes = document.querySelectorAll('iframe, frame');
    for (const iframe of iframes) {
      const src = iframe.getAttribute('src') || '';
      // Try full URL match first
      for (const [origUrl, localFile] of Object.entries(srcMap)) {
        if (origUrl.includes(src) || src.includes(origUrl) || origUrl.endsWith(src)) {
          iframe.setAttribute('src', localFile);
          break;
        }
      }
      // Fallback: just use the path portion
      if (!iframe.getAttribute('src')?.startsWith('iframe-')) {
        const srcPath = src.startsWith('/') ? src : '/' + src;
        for (const [origUrl, localFile] of Object.entries(srcMap)) {
          try {
            const parsed = new URL(origUrl);
            if (parsed.pathname === srcPath || origUrl.endsWith(srcPath)) {
              iframe.setAttribute('src', localFile);
              break;
            }
          } catch {}
        }
      }
    }
    return '<!DOCTYPE html>' + document.documentElement.outerHTML;
  }, Object.fromEntries(iframeSrcMap));

  writeFileSync(join(dir, 'index.html'), mainHtml, 'utf8');
  console.log(`${spec.site}/${spec.page}: ${mainCount} main elements, ${iframeIndex} iframes saved`);
}

// ── Login helper ───────────────────────────────────────────────

async function loginMockConsole(page: Page, tenant: string): Promise<void> {
  await page.goto(`http://localhost:3000/t/${tenant}/login`, { waitUntil: 'load' });
  await page.fill('input[name="f1"]', 'operator');
  await page.fill('input[name="f2"]', 'demo123');
  await page.click('button');
  await page.waitForURL(/dashboard/, { timeout: 5000 });
}

async function loginParaBank(page: Page): Promise<void> {
  await page.goto('https://parabank.parasoft.com/parabank/index.htm', { waitUntil: 'load' });
  await page.locator('input[name="username"]').fill('john');
  await page.locator('input[name="password"]').fill('demo');
  await page.locator('input[value="Log In"]').click();
  await page.waitForURL(/overview/, { timeout: 10000 });
}

// ── Page specifications ────────────────────────────────────────

const MOCK_CONSOLE_PAGES: PageSpec[] = [
  {
    site: 'cascade', page: 'login',
    url: 'http://localhost:3000/t/cascade-cu/login',
  },
  {
    site: 'cascade', page: 'member-sparse',
    url: 'http://localhost:3000/t/cascade-cu/member?q=12345',
    setup: async (page) => { await loginMockConsole(page, 'cascade-cu'); },
    hasIframes: true,
  },
  {
    site: 'cascade', page: 'member-dense',
    url: 'http://localhost:3000/t/cascade-cu/member?q=60020',
    setup: async (page) => { await loginMockConsole(page, 'cascade-cu'); },
    hasIframes: true,
  },
  {
    site: 'harborview', page: 'member-detail',
    url: 'http://localhost:3000/t/harborview/member?q=12345',
    setup: async (page) => { await loginMockConsole(page, 'harborview'); },
    hasIframes: true,
  },
];

const PARABANK_PAGES: PageSpec[] = [
  {
    site: 'parabank', page: 'login',
    url: 'https://parabank.parasoft.com/parabank/index.htm',
  },
  {
    site: 'parabank', page: 'account-overview',
    url: 'https://parabank.parasoft.com/parabank/overview.htm',
    setup: async (page) => { await loginParaBank(page); },
  },
  {
    site: 'parabank', page: 'transfer',
    url: 'https://parabank.parasoft.com/parabank/transfer.htm',
    setup: async (page) => { await loginParaBank(page); },
  },
  {
    site: 'parabank', page: 'bill-pay',
    url: 'https://parabank.parasoft.com/parabank/billpay.htm',
    setup: async (page) => { await loginParaBank(page); },
  },
];

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // Mock console pages — one fresh page per spec (sessions are per-cookie)
  console.log('\n=== Mock Console Pages ===');
  for (const spec of MOCK_CONSOLE_PAGES) {
    const mockPage = await context.newPage();
    try {
      if (spec.setup) await spec.setup(mockPage);
      await mockPage.goto(spec.url, { waitUntil: 'load', timeout: 10000 });
      await mockPage.waitForTimeout(1500);
      // Handle compliance modals
      const ackBtn = mockPage.locator('button:has-text("I Acknowledge")');
      if (await ackBtn.count() > 0) {
        await ackBtn.click();
        await mockPage.waitForTimeout(500);
      }
      await capturePage(mockPage, spec);
    } catch (e) {
      console.error(`FAILED ${spec.site}/${spec.page}: ${(e as Error).message}`);
    }
    await mockPage.close();
  }

  // ParaBank pages (live site — gentle pacing, one login then navigate)
  console.log('\n=== ParaBank Pages ===');
  const pbPage = await context.newPage();
  let pbLoggedIn = false;
  for (const spec of PARABANK_PAGES) {
    try {
      if (spec.setup && !pbLoggedIn) {
        await loginParaBank(pbPage);
        pbLoggedIn = true;
      }
      await pbPage.goto(spec.url, { waitUntil: 'load', timeout: 15000 });
      await pbPage.waitForTimeout(2000);
      await capturePage(pbPage, spec);
      await pbPage.waitForTimeout(1000);
    } catch (e) {
      console.error(`FAILED ${spec.site}/${spec.page}: ${(e as Error).message}`);
    }
  }

  // Altoro login
  console.log('\n=== Altoro ===');
  const altPage = await context.newPage();
  try {
    await altPage.goto('http://demo.testfire.net/login.jsp', { waitUntil: 'load', timeout: 10000 });
    await capturePage(altPage, { site: 'altoro', page: 'login', url: 'http://demo.testfire.net/login.jsp' });
  } catch (e) {
    console.log(`Altoro unreachable: ${(e as Error).message}`);
    console.log('Creating synthetic fixture...');
    createSyntheticAltoro();
  }

  await browser.close();
  console.log('\nCapture complete.');
}

function createSyntheticAltoro() {
  const dir = join(FIXTURES_DIR, 'altoro', 'login');
  mkdirSync(dir, { recursive: true });
  // Synthetic fixture matching Altoro's known structure
  // NOTE: This is a synthetic fixture — Altoro was unreachable during capture
  const html = `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head><title>Altoro Mutual</title>
<style>body{margin:5px;font-family:sans-serif}td{padding:4px}input{padding:2px}</style>
</head>
<body>
<!-- SYNTHETIC FIXTURE: hand-authored to match Altoro's known login page structure.
     Contains the key elements: two text inputs, one submit input (no accessible name
     via ariaLabel/textContent — only the value attribute names it). -->
<div id="wrapper">
<div id="header"><a href="/index.jsp" data-bench-id="bid-0">Home</a>
<a href="/index.jsp" data-bench-id="bid-1"><img src="/images/logo.gif" alt="Altoro Mutual" data-bench-id="bid-2"/></a></div>
<div id="content">
<table>
<tr>
<td><a href="/index.jsp" data-bench-id="bid-3">Home</a></td>
<td><a href="/index.jsp#702702" data-bench-id="bid-4">Inside Altoro Mutual</a></td>
<td><a href="/index.jsp#702703" data-bench-id="bid-5">Personal</a></td>
<td><a href="/index.jsp#702704" data-bench-id="bid-6">Small Business</a></td>
</tr>
</table>
<div id="login">
<h1 data-bench-id="bid-7">Sign In</h1>
<form id="LoginForm" name="login" action="doLogin" method="post">
<table>
<tr><td>Username:</td><td><input type="text" id="uid" name="uid" data-bench-id="bid-8"/></td></tr>
<tr><td>Password:</td><td><input type="password" id="passw" name="passw" data-bench-id="bid-9"/></td></tr>
<tr><td></td><td><input type="submit" name="btnSubmit" value="Login" data-bench-id="bid-10"/></td></tr>
</table>
</form>
</div>
</div>
<div id="footer">
<a href="/index.jsp?content=inside_contact.htm" data-bench-id="bid-11">Contact Us</a> |
<a href="/feedback.jsp" data-bench-id="bid-12">Feedback</a> |
<a href="/subscribe.jsp" data-bench-id="bid-13">Subscribe</a>
</div>
</div>
</body></html>`;
  writeFileSync(join(dir, 'index.html'), html, 'utf8');
  // Write a metadata marker
  writeFileSync(join(dir, 'SYNTHETIC.md'), 'This fixture is hand-authored. Altoro was unreachable during capture.\n', 'utf8');
  console.log('altoro/login: synthetic fixture created');
}

main().catch(e => { console.error(e); process.exit(1); });
