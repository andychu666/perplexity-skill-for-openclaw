#!/usr/bin/env node
/**
 * perplexity-query.js - Query Perplexity Pro via Chrome CDP (pi-adapted)
 *
 * Uses puppeteer-core instead of playwright-core, connects to pi's Chrome on :9222.
 *
 * Usage: node perplexity-query.js [flags] "your question here"
 */

const fs = require('fs');
const path = require('path');

// Resolve puppeteer-core from this skill's own node_modules first, then fall
// back to common locations (e.g. the pi browser-tools skill) so users don't
// have to reinstall if they already have it.
function loadPuppeteer() {
  const candidates = [
    'puppeteer-core',
    path.join(__dirname, '..', 'node_modules', 'puppeteer-core'),
    process.env.PUPPETEER_CORE_PATH,
    path.join(process.env.HOME || '', '.pi/agent/skills/pi-skills/browser-tools/node_modules/puppeteer-core'),
    path.join(process.env.HOME || '', '.codex/skills/pi-skills/browser-tools/node_modules/puppeteer-core'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* try next */ }
  }
  console.error('ERROR: Could not load puppeteer-core. Run `npm install` in the perplexity-pro skill directory,');
  console.error('       or set PUPPETEER_CORE_PATH to an existing puppeteer-core install.');
  process.exit(1);
}
// Lazy: only load puppeteer-core when a browser is actually needed, so the
// module can be require()'d for unit testing pure helpers without Chrome.
let _puppeteer = null;
function puppeteerLib() {
  if (!_puppeteer) _puppeteer = loadPuppeteer();
  return _puppeteer;
}

function log(msg) {
  process.stderr.write('[perplexity] ' + msg + '\n');
}

const DISCOVER_CATEGORIES = ['for-you', 'top', 'tech', 'finance', 'arts', 'sports', 'entertainment'];
// Friendly aliases -> Perplexity Discover slugs
const DISCOVER_ALIASES = { you: 'for-you', 'for-you': 'for-you', foryou: 'for-you', forme: 'for-you' };

const HELP_TEXT = `Usage:
  perplexity-query.js [options] "your question"
  perplexity-query.js --discover [category|all] [--limit N]

Options:
  --brief            Append "Answer briefly in 2-3 sentences"
  --detailed         Append "Provide a detailed, comprehensive answer"
  --chat             Continue in existing Perplexity thread
  --url <URL>        Prepend a URL for Perplexity to analyze (http/https)
  --deep             Enable Deep Research mode (10 min timeout)
  --computer         Use Computer mode (30 min timeout)
  --discover [cat]   List Discover news headlines (default category: top)
  --history "<term>" Search YOUR thread history (Library) for matching threads
  --library "<term>" Alias for --history
  --limit N          Max results for --discover / --history (default 10)
  -h, --help         Show this help and exit
  --                 End of options; everything after is treated as query text`;

function parseArgs(argv) {
  const flags = { brief: false, detailed: false, chat: false, url: null, deep: false, computer: false, discover: null, history: false, limit: 10, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    // `--` ends option parsing: everything after is query text, verbatim.
    if (argv[i] === '--') { positional.push(...argv.slice(i + 1)); break; }
    switch (argv[i]) {
      case '-h':
      case '--help': flags.help = true; break;
      case '--brief': flags.brief = true; break;
      case '--detailed': flags.detailed = true; break;
      case '--chat': flags.chat = true; break;
      case '--deep': flags.deep = true; break;
      case '--computer': flags.computer = true; break;
      case '--history':
      case '--library': flags.history = true; break;
      case '--discover': {
        // Only consume the next token as the category if it's not another flag.
        let cat = 'top';
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          cat = argv[++i];
        }
        flags.discover = DISCOVER_ALIASES[cat.toLowerCase()] || cat.toLowerCase();
        break;
      }
      case '--limit': {
        if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
          console.error('ERROR: --limit requires a positive integer');
          process.exit(1);
        }
        const n = parseInt(argv[++i], 10);
        if (!Number.isFinite(n) || n <= 0) { console.error('ERROR: --limit requires a positive integer'); process.exit(1); }
        flags.limit = n;
        break;
      }
      case '--url':
        i++;
        if (i >= argv.length || argv[i].startsWith('--')) { console.error('ERROR: --url requires a URL argument'); process.exit(1); }
        if (flags.url !== null) { console.error('ERROR: --url specified multiple times'); process.exit(1); }
        try {
          const parsed = new URL(argv[i]);
          if (!['http:', 'https:'].includes(parsed.protocol)) { console.error('ERROR: --url must use http or https scheme'); process.exit(1); }
        } catch { console.error('ERROR: --url value is not a valid URL'); process.exit(1); }
        flags.url = argv[i];
        break;
      default:
        // Reject unknown flags rather than silently sending them to Perplexity.
        // Use `--` before the query to pass dash-prefixed words as text.
        if (argv[i].startsWith('--') || /^-[a-zA-Z]/.test(argv[i])) {
          console.error('ERROR: unknown option "' + argv[i] + '". To pass a dash-prefixed word as part of the query, put it after `--`.\n\n' + HELP_TEXT);
          process.exit(1);
        }
        positional.push(argv[i]);
    }
  }
  return { flags, query: positional.join(' ') };
}

function validateFlags(flags) {
  if (flags.brief && flags.detailed) { console.error('ERROR: --brief and --detailed are mutually exclusive'); process.exit(1); }
  if (flags.deep && flags.computer) { console.error('ERROR: --deep and --computer are mutually exclusive'); process.exit(1); }
  if (flags.chat && flags.computer) { console.error('ERROR: --chat and --computer cannot be combined'); process.exit(1); }
  if (flags.computer && flags.brief) { console.error('ERROR: --brief is not compatible with --computer mode'); process.exit(1); }
}

const CDP_URL = 'http://127.0.0.1:9222';
const OUTPUT_DIR = process.env.PERPLEXITY_OUTPUT_DIR || '/tmp';
const MAX_RETRIES = (() => { const v = parseInt(process.env.PERPLEXITY_RETRIES, 10); return Number.isFinite(v) && v >= 0 ? v : 2; })();

function safeParseTimeout(envVar, defaultMs) {
  const raw = process.env[envVar];
  if (!raw) return defaultMs;
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v) || v <= 0) { log('Warning: invalid ' + envVar + '="' + raw + '", using default ' + defaultMs + 'ms'); return defaultMs; }
  return v;
}

function getTimeoutMs(flags) {
  if (flags.computer) return safeParseTimeout('PERPLEXITY_COMPUTER_TIMEOUT', 30 * 60 * 1000);
  if (flags.deep) return safeParseTimeout('PERPLEXITY_DEEP_TIMEOUT', 10 * 60 * 1000);
  return safeParseTimeout('PERPLEXITY_TIMEOUT', 120000);
}

function buildQuery(rawQuery, flags) {
  let q = rawQuery;
  if (flags.brief) q += ' (Answer briefly in 2-3 sentences.)';
  if (flags.detailed) q += ' (Provide a detailed, comprehensive answer with examples.)';
  if (flags.url) q = flags.url + ' -- ' + q;
  return q;
}

function getModeLabel(flags) {
  if (flags.computer) return 'computer';
  if (flags.deep) return 'deep';
  if (flags.chat) return 'chat';
  return 'standard';
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findInput(page) {
  const selectors = [
    'textarea[placeholder*="Ask"], textarea[placeholder*="ask"], textarea[placeholder*="Type"]',
    '[contenteditable="true"].overflow-auto',
    '[contenteditable="true"]',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) { const visible = await el.evaluate(e => e.offsetHeight > 0); if (visible) return el; }
  }
  return null;
}

async function findFollowUpInput(page) {
  const selectors = [
    'textarea[placeholder*="Follow"], textarea[placeholder*="follow"]',
    'textarea[placeholder*="Ask"], textarea[placeholder*="ask"]',
    '[contenteditable="true"].overflow-auto',
    '[contenteditable="true"]',
  ];
  for (const sel of selectors) {
    const els = await page.$$(sel);
    for (let i = els.length - 1; i >= 0; i--) { const visible = await els[i].evaluate(e => e.offsetHeight > 0); if (visible) return els[i]; }
  }
  return null;
}

async function dismissModals(page) {
  try {
    const closeButtons = await page.$$('button[aria-label="Close"], button[aria-label="close"], button[aria-label="Dismiss"]');
    for (const btn of closeButtons) {
      const visible = await btn.evaluate(e => e.offsetHeight > 0);
      if (visible) { await btn.click().catch(e => log('Warning: modal close click failed: ' + e.message)); await sleep(500); }
    }
  } catch (e) { log('Warning: modal dismissal failed: ' + e.message); }
}

// Puppeteer doesn't support :has-text(); use XPath/text matching helpers.
async function clickByText(page, texts) {
  return page.evaluate((texts) => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"]'));
    for (const t of texts) {
      const el = btns.find(b => (b.innerText || '').trim().includes(t));
      if (el) { el.click(); return true; }
    }
    return false;
  }, texts);
}

// Find an element handle whose trimmed innerText matches one of `texts`.
async function findHandleByText(page, selector, texts, exact) {
  const handles = await page.$$(selector);
  for (const h of handles) {
    const t = (await h.evaluate(el => (el.innerText || '').trim())) || '';
    for (const want of texts) {
      if (exact ? t === want : t.includes(want)) return h;
    }
  }
  return null;
}

async function toggleDeepResearch(page) {
  // The mode selector is a Radix dropdown button (aria-haspopup="menu") next to
  // the search box, labeled "Search" / "Research" / "Deep research". It only
  // opens on a REAL pointer click (element-handle .click()), not synthetic JS click.
  const modeBtn = await findHandleByText(
    page, 'button[aria-haspopup="menu"]',
    ['Search', 'Deep research', 'Research', '\u641c\u7d22', '\u6df1\u5ea6\u7814\u7a76'], true
  );
  if (!modeBtn) {
    log('Warning: Could not find mode selector button - proceeding as standard search');
    return false;
  }

  const curLabel = (await modeBtn.evaluate(el => (el.innerText || '').trim())) || '';
  if (/deep research|\u6df1\u5ea6\u7814\u7a76/i.test(curLabel)) {
    log('Deep Research already selected');
    return true;
  }

  await modeBtn.click();
  await sleep(1000);

  const deepItem = await findHandleByText(
    page, '[role="menuitemradio"], [role="menuitem"], [role="option"]',
    ['Deep research', 'Deep Research', '\u6df1\u5ea6\u7814\u7a76'], false
  );
  if (!deepItem) {
    log('Warning: Deep research option not found in menu - proceeding as standard search');
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await deepItem.click();
  await sleep(800);

  const after = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
      .find(x => /search|deep research|research|\u641c\u7d22|\u6df1\u5ea6\u7814\u7a76/i.test((x.innerText || '').trim()));
    return b ? (b.innerText || '').trim() : '';
  });
  if (/deep research|\u6df1\u5ea6\u7814\u7a76/i.test(after)) {
    log('Deep Research mode enabled');
    return true;
  }
  log('Warning: Deep Research toggle did not confirm (label="' + after + '")');
  return false;
}

async function detectImageGeneration(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    if (/\d+\s*step\s*completed/i.test(text)) return true;
    if (/\d+\s*step/i.test(text) && /generating\s*image/i.test(text)) return true;
    if (/generating\s*image/i.test(text)) return true;
    const stepEls = document.querySelectorAll('[class*="step"], [class*="Step"]');
    for (const el of stepEls) {
      if (el.innerText && /generat/i.test(el.innerText) && /image|photo|picture|illustration/i.test(el.innerText)) return true;
    }
    const imgs = document.querySelectorAll('img[alt*="generated"], img[alt*="Generated"]');
    if (imgs.length > 0) return true;
    const allImgs = document.querySelectorAll('img');
    for (const img of allImgs) { if (img.src && img.src.includes('seedream')) return true; }
    return false;
  });
}

const IMAGE_FILTER_JS = `
  function isRelevantImage(img) {
    return img.naturalWidth > 200 && img.src &&
      !img.src.startsWith('data:') &&
      !img.src.includes('favicon') &&
      !img.src.includes('logo') &&
      !img.src.includes('avatar') &&
      !img.src.includes('icon');
  }
`;

async function waitAndDownloadImages(page, timeoutMs) {
  try {
    await page.waitForFunction(`
      ${IMAGE_FILTER_JS}
      (() => {
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) { if (isRelevantImage(img) && (img.alt || '').length > 5) return true; }
        return false;
      })()
    `, { timeout: Math.min(timeoutMs, 90000) });
  } catch (e) { log('Warning: timed out waiting for generated images: ' + e.message); return []; }

  await sleep(3000);

  const imageUrls = await page.evaluate(`
    ${IMAGE_FILTER_JS}
    (() => {
      const imgs = document.querySelectorAll('img');
      const results = [];
      for (const img of imgs) {
        if (isRelevantImage(img)) results.push({ src: img.src, alt: img.alt || '', width: img.naturalWidth, height: img.naturalHeight });
      }
      const seen = new Set();
      return results.filter(r => { const key = r.src.split('?')[0]; if (seen.has(key)) return false; seen.add(key); return true; });
    })()
  `);

  const safeImages = imageUrls.filter(img => img.src.startsWith('https://'));
  if (safeImages.length < imageUrls.length) log('Warning: filtered out ' + (imageUrls.length - safeImages.length) + ' non-https image URLs');

  const downloaded = [];
  const ts = Date.now();
  for (let i = 0; i < safeImages.length; i++) {
    try {
      const dataUrl = await page.evaluate(async (url) => {
        const res = await fetch(url);
        const blob = await res.blob();
        return new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
      }, safeImages[i].src);
      const base64 = dataUrl.split(',')[1];
      const ext = dataUrl.startsWith('data:image/png') ? 'png' : dataUrl.startsWith('data:image/webp') ? 'webp' : 'jpg';
      const filepath = path.join(OUTPUT_DIR, 'perplexity-gen-' + ts + '-' + i + '.' + ext);
      fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
      downloaded.push({ path: filepath, alt: safeImages[i].alt, width: safeImages[i].width, height: safeImages[i].height });
    } catch (e) { log('Warning: failed to download image ' + i + ': ' + e.message); }
  }
  return downloaded;
}

// ---
// Page-level extraction fallback (Deep Research)
//
// 2026-09-19: a completed Deep Research run returned "[No answer received]" while
// the report (43.9 KB) was verifiably on the page — the primary extractor only
// trusts [class*="prose"] / [class*="markdown"] blocks and the deep-research
// report did not render inside elements carrying those classes.
// ---
let ACTIVE_QUERY = '';

const CHROME_LINES = new Set([
  'Answer', 'Links', 'Images', 'Share', 'Read more', 'Ask a follow-up',
  'Search', 'Computer', 'Model', 'Researched', 'Copy', 'Sources',
  'Show more', 'Show less', 'Summarize', 'Follow up', 'Ask anything',
]);

function stripChromeAndEcho(raw, query) {
  const rawLines = String(raw || '').split('\n');
  const trim = (x) => x.trim();
  const norm = (x) => String(x).normalize('NFKC');
  let lines = rawLines.map(trim);
  const q = trim(query || '');
  if (q) {
    const head = q.split('\n').map(trim).filter(Boolean);
    const cp = (x) => Array.from(x).slice(0, 40).join('');
    const firstAnchor = head.length ? cp(head[0]) : '';
    const lastAnchor = head.length ? cp(head[head.length - 1]) : '';
    const searchEnd = Math.min(lines.length, 200);
    const hit = (anchor) => rawLines.findIndex((l, i) => i < searchEnd
      && norm(trim(l)).startsWith(norm(anchor)));
    const begin = firstAnchor ? hit(firstAnchor) : -1;
    const end = lastAnchor && lastAnchor !== firstAnchor ? hit(lastAnchor) : -1;
    if (begin >= 0) {
      const stop = end > begin ? end : begin;
      lines = lines.slice(stop + 1);
    }
    // Never return the echoed question itself.
    while (firstAnchor && lines.length && norm(lines[0]).startsWith(norm(firstAnchor))) lines.shift();
  }
  lines = lines.filter((l) => l
    && !CHROME_LINES.has(l)
    && !/^\d+\s*(sources?|citations?)$/i.test(l)
    && !/^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(l));
  return lines.join('\n').trim();
}

async function extractPageLevelFallback(page, query) {
  try {
    const read = () => page.evaluate(() => {
      const m = document.querySelector('main') || document.body;
      return (m && m.innerText) || '';
    });
    const first = await read();
    await sleep(1500);
    const second = await read();
    // Compare lengths rather than requiring equality: live chrome (a running timer
    // or a blinking cursor) must not veto recovery of a finished report.
    if (second.length > first.length + 200) return '';
    const cleaned = stripChromeAndEcho(second.length >= first.length ? second : first, query || ACTIVE_QUERY);
    return cleaned.length > 800 ? cleaned : '';
  } catch (e) {
    log(`Warning: page-level fallback failed: ${e.message}`);
    return '';
  }
}

async function typeQuery(page, input, query) {
  const oneLine = query.replace(/\s*\n+\s*/g, ' ').trim();
  await input.click();
  await sleep(300);
  const tagName = await input.evaluate(el => el.tagName);
  if (tagName === 'TEXTAREA' || tagName === 'INPUT') {
    await input.evaluate((el, text) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value') ||
                     Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      setter.set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, oneLine);
  } else {
    await input.evaluate(el => { el.focus(); el.innerText = ''; });
    await page.evaluate((text) => {
      const el = document.activeElement && document.activeElement.isContentEditable
        ? document.activeElement
        : document.querySelector('[contenteditable="true"]');
      if (el) { el.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, text); }
    }, oneLine);
  }
  await sleep(200);
  const got = await input.evaluate(el => (el.value !== undefined ? el.value : el.innerText) || '');
  if (got.trim().length < Math.min(oneLine.length, 10)) {
    log('Warning: input verification short (got ' + got.length + '/' + oneLine.length + ' chars), retrying type');
    await input.type(oneLine, { delay: 10 });
  }
}

async function waitForAnswer(page, timeoutMs, flags) {
  const startTime = Date.now();
  try {
    await page.waitForFunction(() => /perplexity\.ai\/(search|thread|computer)\//.test(window.location.href), { timeout: 15000 }).catch(() => {});
  } catch (e) {}

  await sleep(5000);
  let isImageGen = false;
  try { isImageGen = await detectImageGeneration(page); } catch (e) { log('Warning: image detection failed: ' + e.message); }

  if (!isImageGen) {
    for (let i = 0; i < 12; i++) {
      await sleep(3000);
      try { isImageGen = await detectImageGeneration(page); } catch (e) { log('Warning: image detection poll failed: ' + e.message); }
      if (isImageGen) break;
      try {
        const hasText = await page.evaluate(() => { const el = document.querySelector('[class*="prose"], [class*="markdown"]'); return el && (el.innerText || '').length > 20; });
        if (hasText) break;
      } catch {}
    }
  }

  if (isImageGen) {
    try {
      await page.waitForFunction(() => {
        const text = document.body.innerText || '';
        const stepMatch = text.match(/(\d+)\s*step\s*completed/i);
        if (!stepMatch) return false;
        const generating = document.querySelector('[class*="loading"], [class*="spinner"], [class*="generating"]');
        return !generating;
      }, { timeout: Math.min(timeoutMs, 90000) });
    } catch (e) { log('Warning: image generation wait timed out - proceeding'); }
    await sleep(3000);
  }

  // Extract the most complete answer text from the page. Perplexity streams the
  // answer into one or more [class*="prose"] blocks; the LAST block is not always
  // the answer (it can be a short trailing/related block), so pick the LONGEST
  // block, which is the full answer body.
  const extractText = () => page.evaluate(() => {
    const selectors = ['[class*="prose"]', '[class*="markdown"]', '.whitespace-pre-wrap', 'article'];
    let best = '';
    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        const text = (el && el.innerText) ? el.innerText : '';
        if (text.length > best.length) best = text;
      }
      if (best.length > 5) break;
    }
    return best;
  });

  // Best-effort hint: is Perplexity still actively streaming the answer? When a
  // "stop generating" control is present we are definitely still streaming. This
  // is used ONLY to confirm completion faster -- it is never required to be false
  // before we accept a stable answer, because the heuristic can yield false
  // positives (persistent skeleton loaders, locale-specific labels) that would
  // otherwise pin polling open until the full timeout.
  const isGenerating = () => page.evaluate(() => {
    const stop = Array.from(document.querySelectorAll('button[aria-label], [data-testid]')).some(el => {
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-testid') || '')).toLowerCase();
      return label.includes('stop');
    });
    return stop;
  }).catch(() => false);

  try {
    await page.waitForFunction(() => { const el = document.querySelector('[class*="prose"], [class*="markdown"]'); return el && (el.innerText || '').length > 5; }, { timeout: isImageGen ? 10000 : Math.min(timeoutMs, 60000) });
  } catch (e) { if (!isImageGen) await sleep(10000); }

  // Streaming-completion poll: accept the answer once its text stops growing and
  // stays identical across several consecutive polls. This prevents truncated
  // answers on long, list-heavy responses that briefly pause mid-stream. The
  // "still generating" signal lets us confirm completion sooner (fewer stable
  // polls) but is never required, so a flaky heuristic can't pin us to the full
  // timeout.
  if (isImageGen) {
    let _t = await extractText();
    if (flags.deep && _t.length < 1200) {
      const f = await extractPageLevelFallback(page, ACTIVE_QUERY);
      if (f && f.length > _t.length) { log(`deep: page-level fallback recovered ${f.length} chars`); _t = f; }
    }
    return { text: _t, isImageGen };
  }

  const STABLE_WITH_HINT = 2;   // stable polls needed when UI confirms not-generating
  const STABLE_NO_HINT = 5;     // stable polls needed without that confirmation
  const POLL_MS = 1500;
  let prev = '';
  let stableCount = 0;
  let best = '';
  while (Date.now() - startTime < timeoutMs) {
    await sleep(POLL_MS);
    let cur = '';
    try { cur = await extractText(); } catch (e) { log('Warning: streaming poll failed: ' + e.message); continue; }
    if (cur.length > best.length) best = cur;
    if (cur.length > 5 && cur === prev) {
      stableCount++;
      let generating = false;
      try { generating = await isGenerating(); } catch (e) {}
      const needed = generating ? STABLE_NO_HINT : STABLE_WITH_HINT;
      if (stableCount >= needed) break;
    } else {
      stableCount = 0;
      prev = cur;
    }
  }

  // Final read: take the best (longest) text we have observed.
  let finalText = '';
  try { finalText = await extractText(); } catch (e) { log('Warning: final extraction failed: ' + e.message); }
  if (finalText.length < best.length) finalText = best;
  let _t2 = finalText || best || '';
  if (flags.deep && _t2.length < 1200) {
    const f2 = await extractPageLevelFallback(page, ACTIVE_QUERY);
    if (f2 && f2.length > _t2.length) { log(`deep: page-level fallback recovered ${f2.length} chars`); _t2 = f2; }
  }
  return { text: _t2, isImageGen };
}

async function runQuery(flags, query, timeoutMs) {
  ACTIVE_QUERY = query; // used by the page-level extraction fallback
  let browser;
  try {
    browser = await puppeteerLib().connect({ browserURL: CDP_URL, defaultViewport: null });

    if (flags.chat) {
      let perplexityPage = null;
      const pages = await browser.pages();
      for (const page of pages) { if (page.url().match(/perplexity\.ai\/(search|thread)\//)) { perplexityPage = page; break; } }
      if (!perplexityPage) throw new Error('--chat requires an existing Perplexity search thread. No tab found with a /search/ or /thread/ URL.');
      await perplexityPage.bringToFront();
      const input = await findFollowUpInput(perplexityPage);
      if (!input) throw new Error('Could not find follow-up input in existing thread');
      await typeQuery(perplexityPage, input, query);
      await sleep(500);
      await perplexityPage.keyboard.press('Enter');
      const { text: answer, isImageGen } = await waitForAnswer(perplexityPage, timeoutMs, flags);
      let generatedImages = [];
      if (isImageGen) generatedImages = await waitAndDownloadImages(perplexityPage, 60000);
      const ts = Date.now();
      let screenshotPath = null;
      try { screenshotPath = path.join(OUTPUT_DIR, 'perplexity-result-' + ts + '.png'); await perplexityPage.screenshot({ path: screenshotPath, fullPage: false }); } catch (e) { log('Warning: could not take result screenshot: ' + e.message); }
      return { query, answer: answer || '[No answer received]', mode: 'chat', isImageGeneration: isImageGen, generatedImages, images: [], sources: [], screenshot: screenshotPath, url: perplexityPage.url() };
    }

    const pages = await browser.pages();
    let perplexityPage = pages.find(p => { const url = p.url(); return url.includes('perplexity.ai') && !url.includes('count.perplexity') && !url.includes('service-worker') && !url.startsWith('blob:'); });
    if (!perplexityPage) perplexityPage = await browser.newPage();
    await perplexityPage.bringToFront();

    if (flags.computer) {
      await perplexityPage.goto('https://www.perplexity.ai/computer/new', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    } else {
      await perplexityPage.goto('https://www.perplexity.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
    }

    await dismissModals(perplexityPage);
    if (flags.deep) await toggleDeepResearch(perplexityPage);

    const urlBeforeSubmit = perplexityPage.url();

    const input = await findInput(perplexityPage);
    if (!input) {
      try { const debugPath = path.join(OUTPUT_DIR, 'perplexity-debug-' + Date.now() + '.png'); await perplexityPage.screenshot({ path: debugPath }); log('Debug screenshot: ' + debugPath); } catch (e) { log('Warning: debug screenshot also failed: ' + e.message); }
      throw new Error('Could not find Perplexity search input');
    }

    await typeQuery(perplexityPage, input, query);
    await sleep(500);
    await perplexityPage.keyboard.press('Enter');

    if (!flags.computer) {
      try {
        await perplexityPage.waitForFunction(
          (prev) => window.location.href !== prev && /perplexity\.ai\/(search|thread)\//.test(window.location.href),
          { timeout: 20000 }, urlBeforeSubmit
        );
      } catch (e) { log('Warning: did not observe navigation to a new thread URL'); }
    }

    const { text: answer, isImageGen } = await waitForAnswer(perplexityPage, timeoutMs, flags);
    let generatedImages = [];
    if (isImageGen) generatedImages = await waitAndDownloadImages(perplexityPage, 60000);

    let images = [];
    try { images = await perplexityPage.evaluate(() => { const imgs = document.querySelectorAll('[class*="prose"] img, [class*="markdown"] img, article img'); return Array.from(imgs).map(img => img.src).filter(src => src && !src.startsWith('data:')); }); } catch (e) { log('Warning: inline image extraction failed: ' + e.message); }

    let sources = [];
    try { sources = await perplexityPage.evaluate(() => { const links = document.querySelectorAll('[class*="source"] a, [class*="citation"] a'); return Array.from(links).slice(0, 10).map(a => ({ title: a.textContent ? a.textContent.trim() : '', url: a.href })).filter(s => s.url && !s.url.includes('perplexity.ai')); }); } catch (e) { log('Warning: source extraction failed: ' + e.message); }

    const ts = Date.now();
    let screenshotPath = null;
    try { screenshotPath = path.join(OUTPUT_DIR, 'perplexity-result-' + ts + '.png'); await perplexityPage.screenshot({ path: screenshotPath, fullPage: false }); } catch (e) { log('Warning: could not take result screenshot: ' + e.message); }

    return { query, answer: answer || (isImageGen ? '[Image generated - see generatedImages]' : '[No answer received]'), mode: getModeLabel(flags), isImageGeneration: isImageGen, generatedImages, images, sources, screenshot: screenshotPath, url: perplexityPage.url() };
  } finally {
    if (browser) { try { await browser.disconnect(); } catch (e) {} }
  }
}

// ---
// Discover feed: scrape headlines for a category (top|tech|finance|arts|sports|entertainment|for-you)
// ---
async function scrapeDiscoverCategory(page, category, limit) {
  await page.goto('https://www.perplexity.ai/discover/' + category, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3500);
  // Lazy-load: scroll a bit to pull in more cards if a high limit is requested.
  if (limit > 8) {
    for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, window.innerHeight)); await sleep(900); }
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);
  }
  const stories = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const a of Array.from(document.querySelectorAll('a[href*="/discover/"]'))) {
      const href = a.getAttribute('href') || '';
      // story links look like /discover/<cat>/<slug-with-id>; skip the bare tab link
      if (!/^\/discover\/[a-z-]+\/[^/?#]+/.test(href)) continue;
      const raw = (a.innerText || '').trim();
      if (raw.length < 12) continue;
      // First line is the title; remaining lines hold meta (published / N sources / summary)
      const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
      const title = lines[0];
      const meta = lines.slice(1).join(' ');
      const sourcesMatch = meta.match(/(\d+)\s*sources?/i);
      const publishedMatch = raw.match(/Published\s*\n?\s*([^\n]+)/i);
      const key = href.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        title,
        url: 'https://www.perplexity.ai' + href,
        sources: sourcesMatch ? parseInt(sourcesMatch[1], 10) : null,
        published: publishedMatch ? publishedMatch[1].trim() : null,
      });
    }
    return out;
  });
  return stories.slice(0, limit);
}

async function runDiscover(category, limit) {
  let browser;
  try {
    browser = await puppeteerLib().connect({ browserURL: CDP_URL, defaultViewport: null });
    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('perplexity.ai')) || await browser.newPage();
    await page.bringToFront();

    const categories = category === 'all' ? DISCOVER_CATEGORIES : [category];
    const result = { mode: 'discover', generatedAt: new Date().toISOString(), categories: {} };
    for (const cat of categories) {
      log('Discover: scraping /' + cat);
      try {
        result.categories[cat] = await scrapeDiscoverCategory(page, cat, limit);
      } catch (e) {
        log('Warning: failed to scrape ' + cat + ': ' + e.message);
        result.categories[cat] = [];
      }
    }
    return result;
  } finally {
    if (browser) { try { await browser.disconnect(); } catch (e) {} }
  }
}

// ---
// History / Library: search the signed-in user's own past threads.
// Perplexity's Library has a "Search your threads" button that opens a filter
// box; results render in <main> (NOT the left sidebar, which always shows the
// 20 most-recent regardless of the filter). The search is semantic/fuzzy, so a
// match may not contain the literal term. Row text looks like:
//   "<type>\n<title>[\n<file chip>]\n<N> <unit> ago"   e.g. "Search\nfoo\n2mo ago"
// ---
const HISTORY_ROW_TYPES = ['Deep research', 'Deep Research', 'Search', 'Computer', 'Labs', 'Page', 'Task'];
const HISTORY_AGE_RE = /\b\d+\s*(?:sec|min|m|h|hr|d|w|mo|y)\s*ago$/i;

// Parse one row's innerText into { type, title, age }. Pure + exported for tests.
function parseHistoryRowText(text) {
  const lines = String(text).split('\n').map(s => s.trim()).filter(Boolean);
  let type = '';
  let age = '';
  const body = [];
  for (const ln of lines) {
    if (!type && HISTORY_ROW_TYPES.includes(ln)) { type = ln; continue; }
    if (HISTORY_AGE_RE.test(ln)) { age = ln; continue; }
    body.push(ln);
  }
  // The title is the longest remaining line (file chips / labels are short).
  const title = body.slice().sort((a, b) => b.length - a.length)[0] || '';
  return { type, title, age };
}

// Parse the whole <main> innerText into rows. Pure + exported for tests.
function parseHistoryRows(mainText) {
  const lines = String(mainText).split('\n').map(s => s.trim()).filter(Boolean);
  const groups = [];
  let cur = null;
  for (const ln of lines) {
    if (HISTORY_ROW_TYPES.includes(ln)) { if (cur) groups.push(cur); cur = [ln]; }
    else if (cur) { cur.push(ln); if (HISTORY_AGE_RE.test(ln)) { groups.push(cur); cur = null; } }
  }
  if (cur) groups.push(cur);
  return groups.map(g => parseHistoryRowText(g.join('\n'))).filter(r => r.title);
}

// Heuristic: did the signed-in Library shell actually render? These controls
// appear regardless of how many threads match; a logged-out/redirected page does
// not have them. Lets us tell "0 genuine matches" apart from "Library never
// loaded" (e.g. session expired) so the latter can't masquerade as 0 results.
// Pure + exported for tests.
function libraryShellPresent(mainText) {
  return /temporary threads|sort:\s|new thread/i.test(String(mainText));
}

// Read the Library <main> panel: its innerText (reliable source of result rows)
// plus any thread anchors (best-effort URL enrichment — usually none, since rows
// navigate via the SPA router rather than <a> tags).
async function readLibraryMain(page) {
  return await page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    const anchors = Array.from(main.querySelectorAll('a[href]'))
      .filter(a => /\/(search|thread|page)\//.test(a.href))
      .map(a => ({ href: a.href, text: (a.innerText || '').trim() }))
      .filter(a => a.text.length > 0);
    return { mainText: main.innerText || '', anchors };
  });
}

async function runHistory(query, limit) {
  let browser;
  try {
    browser = await puppeteerLib().connect({ browserURL: CDP_URL, defaultViewport: null });
    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('perplexity.ai')) || await browser.newPage();
    await page.bringToFront();

    const oneLine = String(query).replace(/\s*\n+\s*/g, ' ').trim();

    // Primary path: the Library honours a ?q=<term> query param and renders the
    // filtered results directly — more robust than driving the search overlay.
    await page.goto('https://www.perplexity.ai/library?q=' + encodeURIComponent(oneLine),
      { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3500);

    // Cookie consent overlay can sit on top; dismiss if present, then re-read.
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(x => /decline optional|got it|accept all|i agree|accept/i.test((x.innerText || '').trim()));
      if (b) b.click();
    });
    await sleep(400);

    let raw = await readLibraryMain(page);
    let shell = libraryShellPresent(raw.mainText);
    let rows = shell ? parseHistoryRows(raw.mainText) : [];

    // Fallback ONLY when the Library shell didn't render (param ignored / older
    // UI) — NOT when it rendered with zero genuine matches. Drive the "Search
    // your threads" overlay manually.
    if (!shell) {
      const opened = await page.evaluate(() => {
        const b = document.querySelector('button[aria-label="Search your threads"]')
          || Array.from(document.querySelectorAll('button, [role="button"]'))
              .find(x => /search your threads/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.innerText || '')));
        if (b) { b.click(); return true; }
        return false;
      });
      if (opened) {
        await sleep(800);
        await page.keyboard.type(oneLine, { delay: 35 });
        await sleep(2600);
        raw = await readLibraryMain(page);
        shell = libraryShellPresent(raw.mainText);
        rows = shell ? parseHistoryRows(raw.mainText) : [];
      }
    }

    // Distinguish "no matches" (shell present, 0 rows) from "Library didn't load"
    // (signed out / redirected to login). The latter must surface as an error,
    // never as a misleading empty result.
    if (!shell) {
      throw new Error('Perplexity Library did not render — check you are signed in at perplexity.ai '
        + '(no History / "Search your threads" UI found). Current URL: ' + page.url());
    }

    // Best-effort URL enrichment (usually null — rows aren't <a> tags).
    for (const r of rows) {
      const probe = r.title.slice(0, 30);
      const a = raw.anchors.find(x => x.text.includes(probe) || (x.text && r.title.includes(x.text.slice(0, 30))));
      r.url = a ? a.href : null;
    }

    const ts = Date.now();
    let screenshot = null;
    try { screenshot = path.join(OUTPUT_DIR, 'perplexity-history-' + ts + '.png'); await page.screenshot({ path: screenshot, fullPage: false }); } catch (e) { log('Warning: could not take history screenshot: ' + e.message); }

    return { mode: 'history', query: oneLine, count: Math.min(rows.length, limit), threads: rows.slice(0, limit), screenshot, url: page.url() };
  } finally {
    if (browser) { try { await browser.disconnect(); } catch (e) {} }
  }
}

async function main() {
  const { flags, query } = parseArgs(process.argv.slice(2));

  if (flags.help) { console.log(HELP_TEXT); process.exit(0); }

  // Discover mode: list news headlines by category (no query needed)
  if (flags.discover) {
    if (flags.discover !== 'all' && !DISCOVER_CATEGORIES.includes(flags.discover)) {
      console.error('ERROR: unknown discover category "' + flags.discover + '". Valid: ' + DISCOVER_CATEGORIES.join(', ') + ', all (use "you" for for-you)');
      process.exit(1);
    }
    log('Mode: discover | Category: ' + flags.discover + ' | Limit: ' + flags.limit);
    try {
      const result = await runDiscover(flags.discover, flags.limit);
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (err) {
      console.error('ERROR: discover failed: ' + err.message);
      process.exit(1);
    }
  }

  // History mode: search the signed-in user's own past threads (Library)
  if (flags.history) {
    if (!query) { console.error('ERROR: --history requires a search term, e.g. --history "whisper"'); process.exit(1); }
    log('Mode: history | Query: ' + query.substring(0, 80) + ' | Limit: ' + flags.limit);
    try {
      const result = await runHistory(query, flags.limit);
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (err) {
      console.error('ERROR: history search failed: ' + err.message);
      process.exit(1);
    }
  }

  if (!query) { console.error('Usage: node perplexity-query.js [--brief|--detailed] [--chat|--deep|--computer] [--url <URL>] "your question"\n       node perplexity-query.js --discover [category|all] [--limit N]\n       node perplexity-query.js --history "<term>" [--limit N]'); process.exit(1); }
  validateFlags(flags);
  const finalQuery = buildQuery(query, flags);
  const timeoutMs = getTimeoutMs(flags);
  const mode = getModeLabel(flags);
  log('Mode: ' + mode + ' | Timeout: ' + timeoutMs + 'ms | Query: ' + query.substring(0, 80) + (query.length > 80 ? '...' : ''));
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) { const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); log('Retry ' + attempt + '/' + MAX_RETRIES + ' after ' + backoffMs + 'ms backoff...'); await sleep(backoffMs); }
    try {
      const result = await runQuery(flags, finalQuery, timeoutMs);
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (err) {
      lastError = err;
      log('Attempt ' + (attempt + 1) + ' failed: ' + err.message);
      if (err.message.includes('--chat requires') || err.message.includes('Could not find follow-up') || err.message.includes('Could not connect') || err.message.includes('connect ECONNREFUSED')) break;
    }
  }
  console.error('ERROR: All attempts failed. Last error: ' + (lastError ? lastError.message : 'unknown'));
  process.exit(1);
}

// Only run the CLI when executed directly (not when require()'d by tests).
if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  validateFlags,
  buildQuery,
  getModeLabel,
  getTimeoutMs,
  safeParseTimeout,
  parseHistoryRowText,
  parseHistoryRows,
  libraryShellPresent,
  DISCOVER_CATEGORIES,
  DISCOVER_ALIASES,
};
