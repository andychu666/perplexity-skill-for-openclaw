#!/usr/bin/env node
/**
 * perplexity-query.js - Query Perplexity Pro via Chrome CDP (pi-adapted)
 *
 * Uses puppeteer-core instead of playwright-core, connects to the OpenClaw-managed Chrome (CDP on :18800 by default;
 * override with PERPLEXITY_CDP).
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
    path.join(process.env.HOME || '', 'node_modules', 'puppeteer-core'),
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
  --thread <URL>     Thread to continue (with --chat); opened if no tab matches
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
  const flags = { brief: false, detailed: false, chat: false, thread: null, url: null, deep: false, computer: false, discover: null, history: false, limit: 10, help: false };
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
      case '--thread': {
        if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) { console.error('ERROR: --thread requires a URL argument'); process.exit(1); }
        if (flags.thread !== null) { console.error('ERROR: --thread specified multiple times'); process.exit(1); }
        const threadUrl = argv[++i];
        try {
          const parsed = new URL(threadUrl);
          // Exact host match: endsWith('perplexity.ai') accepts evilperplexity.ai,
          // which would navigate the *signed-in* CDP browser to an attacker origin.
          const host = parsed.hostname.toLowerCase();
          const okHost = host === 'perplexity.ai' || host.endsWith('.perplexity.ai');
          if (!['http:', 'https:'].includes(parsed.protocol) || !okHost) {
            console.error('ERROR: --thread must be a perplexity.ai http(s) URL');
            process.exit(1);
          }
        } catch { console.error('ERROR: --thread value is not a valid URL'); process.exit(1); }
        flags.thread = threadUrl;
        break;
      }
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

// One browser for both paths: the OpenClaw-managed Chrome (18800), the same
// default session-core.js uses, so the UI path and the internal-API path drive
// one profile and one login. PERPLEXITY_CDP overrides it.
const CDP_URL = process.env.PERPLEXITY_CDP || 'http://127.0.0.1:18800';
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

async function waitForFollowUpInput(page, timeoutMs = 20000) {
  // The thread view renders its composer after hydration, and Chrome may have
  // discarded a background tab (URL kept, DOM gone) — so poll, and reload once if
  // the page reports no composer at all despite being "complete".
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let reloaded = false;
  for (;;) {
    attempt++;
    const input = await findFollowUpInput(page);
    if (input) return input;

    const probe = await page.evaluate(() => ({
      ce: document.querySelectorAll('[contenteditable="true"]').length,
      ta: document.querySelectorAll('textarea').length,
      ready: document.readyState,
      bodyChildren: document.body ? document.body.childElementCount : -1,
    })).catch(() => null);

    if (process.env.PPLX_DEBUG_INPUT) log(`input probe #${attempt}: ${JSON.stringify(probe)}`);

    if (!reloaded && probe && probe.ready === 'complete'
        && probe.ce === 0 && probe.ta === 0 && attempt >= 2) {
      reloaded = true;
      log('No composer found and the page looks discarded; reloading once');
      try { await page.reload({ waitUntil: 'domcontentloaded' }); } catch (e) { log('Warning: reload failed: ' + e.message); }
      await sleep(2500);
      continue;
    }

    if (Date.now() > deadline) return null;
    await sleep(1000);
  }
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
  // Same-millisecond runs used to overwrite each other's artifacts.
  const uid = () => `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  for (let i = 0; i < safeImages.length; i++) {
    try {
      const dataUrl = await page.evaluate(async (url) => {
        // Per-image bounds: without them one stalled request hangs the run and
        // one huge (or non-image) response lands in memory as a data URL.
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        try {
          const res = await fetch(url, { signal: ctrl.signal });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const type = res.headers.get('content-type') || '';
          if (!type.startsWith('image/')) throw new Error('not an image (' + type + ')');
          const blob = await res.blob();
          if (blob.size > 8 * 1048576) throw new Error('image too large: ' + blob.size + ' bytes');
          return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
        } finally { clearTimeout(t); }
      }, safeImages[i].src);
      const base64 = dataUrl.split(',')[1];
      const ext = dataUrl.startsWith('data:image/png') ? 'png' : dataUrl.startsWith('data:image/webp') ? 'webp' : 'jpg';
      const filepath = path.join(OUTPUT_DIR, 'perplexity-gen-' + uid() + '-' + i + '.' + ext);
      fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
      downloaded.push({ path: filepath, alt: safeImages[i].alt, width: safeImages[i].width, height: safeImages[i].height });
    } catch (e) { log('Warning: failed to download image ' + i + ': ' + e.message); }
  }
  return downloaded;
}

async function typeQuery(page, input, query) {
  const oneLine = query.replace(/\s*\n+\s*/g, ' ').trim();
  await input.click();
  await sleep(300);
  const tagName = await input.evaluate(el => el.tagName);
  if (tagName === 'TEXTAREA' || tagName === 'INPUT') {
    await input.evaluate((el, text) => {
      // Pick the setter for the element's OWN prototype: reading the textarea
      // descriptor first made `setter.set.call(inputEl, ...)` throw
      // "Illegal invocation" on the INPUT composer, so nothing was typed.
      const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
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
  // Verify the WHOLE query landed: the old check only required min(len, 10)
  // characters, so a truncated composer submitted a different question and
  // still looked fine.
  const readBack = async () => String(
    await input.evaluate(el => (el.value !== undefined ? el.value : el.innerText) || '')
  ).replace(/\s+/g, ' ').trim();
  const want = oneLine.replace(/\s+/g, ' ').trim();
  let got = await readBack();
  if (got !== want) {
    log('Warning: input verification short (got ' + got.length + '/' + want.length + ' chars), retrying type');
    await input.type(oneLine, { delay: 10 });
    await sleep(300);
    got = await readBack();
  }
  if (got !== want) {
    throw new Error('Could not type the full query (composer holds ' + got.length + '/' + want.length + ' chars)');
  }
}

// The selector lists extraction walks, in priority order: the classes Perplexity
// currently renders answers in first, then the fallbacks used when an answer
// renders without them. The pre-submit snapshot counts EVERY list separately —
// the lists have different lengths, so one shared index would either cut real
// blocks or keep earlier turns' prose.
const EXTRACT_SELECTORS = ['[class*="prose"]', '[class*="markdown"]', '.whitespace-pre-wrap', 'article'];

// Snapshot how many blocks each extraction list currently has mounted. Callers
// take this before submitting so extraction can restrict itself to the blocks
// mounted after it — each list's count is a valid index into that very list.
async function countProseBlocks(page) {
  // Throws when the snapshot fails: an empty snapshot would silently disable the
  // pre-submit scoping and let the previous turn's prose be extracted as the new
  // answer. Only the chat path calls this, so a failed snapshot fails loudly
  // there instead of degrading into the leak this scoping exists to prevent.
  return await page.evaluate((selectors) =>
    selectors.map((sel) => document.querySelectorAll(sel).length), EXTRACT_SELECTORS);
}

async function waitForAnswer(page, timeoutMs, flags, blocksBefore = null) {
  const startTime = Date.now();
    // Every warm-up wait is bounded by the REMAINING budget: the flat 5s plus up
    // to 12 x 3s below ignored --timeout entirely, so a short timeout was blown
    // before extraction even started.
    const remaining = () => Math.max(0, timeoutMs - (Date.now() - startTime));
  try {
    await page.waitForFunction(() => /perplexity\.ai\/(search|thread|computer)\//.test(window.location.href), { timeout: Math.min(15000, Math.max(1000, remaining())) }).catch(() => {});
  } catch (e) {}

  await sleep(Math.min(5000, remaining()));
  let isImageGen = false;
  try { isImageGen = await detectImageGeneration(page); } catch (e) { log('Warning: image detection failed: ' + e.message); }

  if (!isImageGen) {
    for (let i = 0; i < 12 && remaining() > 0; i++) {
        await sleep(Math.min(3000, remaining()));
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
  // `blocksBefore` = per-list block counts snapshotted before this query was
  // submitted (null when the caller did not snapshot). In an existing chat thread
  // the earlier turns' blocks stay mounted, and picking the longest text would
  // return the PREVIOUS answer instead of the new one, so a scoped run keeps only
  // the blocks mounted after the snapshot in each list.
  const extractText = (blocksBefore = null) => page.evaluate((before, selectors) => {
    // All selectors stay in play in scoped (chat) runs: each list is sliced at its
    // own pre-submit count — the index into the very list the snapshot counted —
    // so an answer rendering in a fallback selector is still found instead of
    // polling empty until the whole timeout burns.
    const scoped = Array.isArray(before);
    if (scoped && before.length !== selectors.length) throw new Error('block snapshot does not match the extraction selectors');
    let best = '';
    for (let i = 0; i < selectors.length; i++) {
      const all = Array.from(document.querySelectorAll(selectors[i]));
      const els = scoped ? all.slice(before[i]) : all;
      for (const el of els) {
        const text = (el && el.innerText) ? el.innerText : '';
        if (text.length > best.length) best = text;
      }
      if (best.length > 5) break;
    }
    // A scoped slice that came back empty means the thread's blocks are
    // re-mounting: return nothing so the caller keeps polling and its
    // "no answer extracted" check fails loudly. Falling back to the newest
    // mounted block would silently return the PREVIOUS turn's answer.
    return best;
  }, blocksBefore, EXTRACT_SELECTORS);

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
    return { text: await extractText(blocksBefore), isImageGen };
  }

  // Chat follow-ups stream like Deep Research, so they need a longer quiet window
  // than a one-shot answer (review finding: chat was accepted while still partial).
  const STABLE_WITH_HINT = flags.chat ? 4 : 2;   // stable polls needed when UI confirms not-generating
  const STABLE_NO_HINT = flags.chat ? 7 : 5;     // stable polls needed without that confirmation
  const POLL_MS = 1500;
  let prev = '';
  let stableCount = 0;
  let best = '';
  let stable = false;
  while (Date.now() - startTime < timeoutMs) {
    await sleep(POLL_MS);
    let cur = '';
    try { cur = await extractText(blocksBefore); } catch (e) { log('Warning: streaming poll failed: ' + e.message); continue; }
    if (cur.length > best.length) best = cur;
    if (cur.length > 5 && cur === prev) {
      stableCount++;
      let generating = false;
      try { generating = await isGenerating(); } catch (e) {}
      const needed = generating ? STABLE_NO_HINT : STABLE_WITH_HINT;
      if (stableCount >= needed) { stable = true; break; }
    } else {
      stableCount = 0;
      prev = cur;
    }
  }

  // Final read: take the best (longest) text we have observed.
  let finalText = '';
  try { finalText = await extractText(blocksBefore); } catch (e) { log('Warning: final extraction failed: ' + e.message); }
  if (finalText.length < best.length) finalText = best;
  const text = finalText || best || '';
  if (!stable) {
    // The deadline passed before the text stopped growing: what we have is the
    // longest prefix observed, NOT a complete answer. Say so explicitly — the
    // old shape let every caller print a truncated prefix as a final answer with
    // exit 0 — while still handing the partial text back so it is never dropped.
    log('Warning: the answer never stopped growing before the timeout; returning ' + text.length + ' chars as an incomplete answer');
    return { text, isImageGen, incomplete: true, reason: 'timeout' };
  }
  return { text, isImageGen };
}

async function runQuery(flags, query, timeoutMs) {
  let browser;
  let openedPage = null;
  try {
    // protocolTimeout: without it a wedged CDP socket makes every page call hang
    // forever instead of failing.
    browser = await puppeteerLib().connect({ browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 60000 });

    if (flags.chat) {
      // Preferred path: submit the follow-up through the session layer. No
      // composer, no menu, no stream settling — the thread is addressed by URL.
      if (flags.thread) {
        let session = null;
        let submitted = false;
        // Entry count before submitting: an unchanged count after a failed
        // submit proves no POST landed, so the UI fallback is safe to use.
        let entriesBefore = null;
        try {
          session = require('./session.js');
          // The count is the growth baseline the read-back below needs, and a
          // transient read failure here would dead-end the whole submit, so retry
          // it once before leaving the baseline unknown.
          for (let snapshotAttempt = 0; snapshotAttempt < 2 && entriesBefore === null; snapshotAttempt++) {
            try {
              const snapshot = await session.latestAnswer(flags.thread);
              if (snapshot && Number.isFinite(snapshot.entries)) entriesBefore = snapshot.entries;
            } catch (e) {
              if (snapshotAttempt === 1) {
                log('Warning: could not snapshot the thread entry count (' + e.message + '); the UI fallback will be unavailable if the submit does not land');
              }
            }
          }
          log('chat: submitting through the session layer (no UI)');
          submitted = true;
          const asked = await session.submitAsk(query, { threadUrl: flags.thread });
          if (asked.answer && asked.answer.trim()) {
            log(`chat: answered via session (${asked.answer.length} chars)`);
            return {
              query, answer: asked.answer, mode: 'chat', isImageGeneration: false,
              generatedImages: [], images: [], sources: [], screenshot: null,
              url: asked.slug ? `https://www.perplexity.ai/search/${asked.slug}` : flags.thread,
            };
          }
          log('Warning: session ask returned an empty answer; retrying the read-back');
        } catch (e) {
          log('Warning: session ask failed (' + e.message + '); retrying the read-back');
        }
        if (submitted) {
          // The follow-up may already have been POSTed, so the UI path would ask
          // the same question a second time. Poll the thread for the answer
          // instead, then fail loudly — never re-submit through the UI.
          const readbackAttempts = 6;
          const readbackGapMs = 5000;
          let answer = '';
          let slug = null;
          let lastError = null;
          // Baseline unknown after the retry: no read-back can be attributed to
          // this submit — the thread's last entry may still be the PREVIOUS turn's
          // answer — so one read is kept as clearly-marked unverified content for
          // the failure report below, and the run fails. It is never returned as
          // this turn's answer, and polling 6 times would not help: nothing could
          // ever verify it.
          let unverifiedAnswer = '';
          let unverifiedSlug = null;
          if (entriesBefore === null) {
            try {
              const read = await session.latestAnswer(flags.thread);
              if (read.answer && read.answer.trim()) { unverifiedAnswer = read.answer; unverifiedSlug = read.slug; }
            } catch (e) { lastError = e; }
          } else {
            for (let attempt = 0; attempt < readbackAttempts && !answer; attempt++) {
              if (attempt > 0) await sleep(readbackGapMs);
              try {
                // Scope the walk-back to entries this submit could have added and
                // require the count to have grown past the pre-submit snapshot:
                // without both, a slow or aborted stream hands back the PREVIOUS
                // turn's answer as this turn's reply.
                const read = await session.latestAnswer(flags.thread, { minEntries: entriesBefore + 1 });
                if (Number.isFinite(read.entries) && read.entries > entriesBefore && read.answer && read.answer.trim()) {
                  answer = read.answer; slug = read.slug;
                }
              } catch (e) { lastError = e; }
            }
          }
          if (answer && answer.trim()) {
            log(`chat: answered via session (${answer.length} chars)`);
            return {
              query, answer, mode: 'chat', isImageGeneration: false,
              generatedImages: [], images: [], sources: [], screenshot: null,
              url: slug ? `https://www.perplexity.ai/search/${slug}` : flags.thread,
            };
          }
          // No answer. An entry count identical to the pre-submit snapshot proves
          // the submit never POSTed (e.g. the session layer rejected the URL), so
          // the question can safely be asked through the UI instead. If the thread
          // grew — or the counts cannot be compared — the POST may have landed:
          // fail loudly and never re-submit.
          let gainedEntry = true;
          if (entriesBefore !== null) {
            try {
              const now = await session.latestAnswer(flags.thread);
              gainedEntry = !(now && Number.isFinite(now.entries) && now.entries === entriesBefore);
            } catch (e) { lastError = lastError || e; }
          }
          if (gainedEntry) {
            if (entriesBefore === null) {
              // The baseline never materialised, so the read-back can never be
              // attributed to this submit: report FAILURE (the run exits non-zero
              // through the structured error path) and carry the content that was
              // read along as clearly-marked unverified output — never as the
              // answer, never dropped.
              const err = new Error('chat: the thread entry count stayed unavailable, so the answer read back from the thread'
                + ' cannot be attributed to this submit (it may be the previous turn\'s answer); refusing to return it as this turn\'s answer'
                + (lastError ? ' (' + lastError.message + ')' : '')
                + '. Thread: ' + flags.thread);
              if (unverifiedAnswer) {
                err.partialResult = {
                  query, answer: unverifiedAnswer, mode: 'chat', isImageGeneration: false,
                  generatedImages: [], images: [], sources: [], screenshot: null,
                  url: unverifiedSlug ? `https://www.perplexity.ai/search/${unverifiedSlug}` : flags.thread,
                  incomplete: true, unverified: true, reason: 'baseline-unknown',
                };
              }
              throw err;
            }
            throw new Error('chat: the follow-up was submitted through the session layer but no answer could be read back from the thread'
              + ' after ' + readbackAttempts + ' attempts'
              + (lastError ? ' (' + lastError.message + ')' : '')
              + '; refusing to re-submit it through the UI. Thread: ' + flags.thread);
          }
          log('chat: the session submit added no thread entry; falling back to the UI');
        }
      }

      let perplexityPage = null;
      const pages = await browser.pages();
      if (flags.thread) {
        // Explicit thread: reuse a tab already on it, otherwise open one, so the
        // caller does not have to leave the right thread focused by hand.
        perplexityPage = pages.find((p) => p.url().startsWith(flags.thread)) || null;
        if (!perplexityPage) {
          perplexityPage = await browser.newPage();
          openedPage = perplexityPage;
          await perplexityPage.goto(flags.thread, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(2000);
        }
        await perplexityPage.bringToFront();
      } else {
        for (const page of pages) { if (page.url().match(/perplexity\.ai\/(search|thread)\//)) { perplexityPage = page; break; } }
      }
      if (!perplexityPage) throw new Error('--chat requires an existing Perplexity search thread. No tab found with a /search/ or /thread/ URL.');
      await perplexityPage.bringToFront();
      const input = await waitForFollowUpInput(perplexityPage);
      if (!input) throw new Error('Could not find follow-up input in existing thread');
      // Snapshot the block count before submitting so extraction can ignore the
      // earlier turns already mounted in this thread.
      const blocksBefore = await countProseBlocks(perplexityPage);
      // Same for the thread's entry count: the read-back below only accepts an
      // answer from an entry this submit added, or a slow stream hands back the
      // PREVIOUS turn's answer over the DOM answer this run already extracted.
      let entriesBeforeUi = null;
      try {
        const snapshot = await require('./session.js').latestAnswer(perplexityPage.url());
        if (snapshot && Number.isFinite(snapshot.entries)) entriesBeforeUi = snapshot.entries;
      } catch (e) {
        log('Warning: could not snapshot the thread entry count (' + e.message + '); the session read-back will be skipped');
      }
      await typeQuery(perplexityPage, input, query);
      await sleep(500);
      await perplexityPage.keyboard.press('Enter');
      const { text: answer, isImageGen, incomplete, reason } = await waitForAnswer(perplexityPage, timeoutMs, flags, blocksBefore);

      // Prefer reading the answer back from the thread itself: the thread JSON
      // carries the finished answer, so the result no longer depends on DOM
      // extraction at all (only the submission still touches the UI). The read-back
      // is accepted only when the thread grew past the pre-submit snapshot;
      // otherwise the DOM answer stands — a correct DOM answer is never replaced
      // by a possibly stale one.
      let finalAnswer = answer;
      // The timeout flag taints the DOM text only: a read-back that proved the
      // thread grew past the pre-submit snapshot supplies this turn's answer
      // itself, so the truncation the flag warns about no longer applies.
      let incompleteAnswer = incomplete === true;
      // Kept for the failure report only: with no pre-submit baseline, a read-back
      // cannot be attributed to this submit — it may be the PREVIOUS turn's answer.
      let unverifiedReadback = null;
      if (!isImageGen) {
        try {
          const session = require('./session.js');
          const read = await session.latestAnswer(perplexityPage.url(),
            entriesBeforeUi === null ? {} : { minEntries: entriesBeforeUi + 1 });
          const grew = entriesBeforeUi !== null && Number.isFinite(read.entries) && read.entries > entriesBeforeUi;
          if (grew && read.answer && read.answer.trim()) {
            finalAnswer = read.answer;
            incompleteAnswer = false;
            log(`chat: read answer back from the session (${read.answer.length} chars, ${read.entries} entries)`);
          } else if (entriesBeforeUi !== null) {
            log('chat: the thread did not grow past the pre-submit entry count; keeping the DOM answer');
          } else if (read.answer && read.answer.trim()) {
            // Baseline unknown: never accepted as the answer (the DOM answer
            // stands), kept strictly as unverified content for a failure report.
            unverifiedReadback = read.answer;
            log('chat: the pre-submit entry count is unavailable, so the session read-back cannot be attributed to this submit; keeping it as unverified content only');
          }
        } catch (e) {
          log('Warning: session read-back failed (' + e.message + '); using the DOM answer');
        }
      }
      let generatedImages = [];
      if (isImageGen) generatedImages = await waitAndDownloadImages(perplexityPage, 60000);
      const ts = Date.now() + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
      let screenshotPath = null;
      try { screenshotPath = path.join(OUTPUT_DIR, 'perplexity-result-' + ts + '.png'); await perplexityPage.screenshot({ path: screenshotPath, fullPage: false }); } catch (e) { log('Warning: could not take result screenshot: ' + e.message); }
      if (!finalAnswer || !finalAnswer.trim()) {
        // An empty extraction used to be returned as the placeholder string with
        // exit 0, so a timeout / login wall / block looked like a complete answer
        // to every caller and cache. Fail loudly instead.
        const err = new Error('No answer extracted for the follow-up — the page may be showing a login wall, '
          + 'a block, or an empty response. Current URL: ' + perplexityPage.url());
        if (unverifiedReadback) {
          // The baseline-unknown read-back is never the answer, but it is the only
          // content this run obtained: report it as unverified instead of dropping it.
          err.partialResult = {
            query, answer: unverifiedReadback, mode: 'chat', isImageGeneration: isImageGen,
            generatedImages, images: [], sources: [], screenshot: screenshotPath, url: perplexityPage.url(),
            incomplete: true, unverified: true, reason: 'baseline-unknown',
          };
        }
        throw err;
      }
      if (incompleteAnswer) {
        log('chat: reporting the run as incomplete (timeout before the answer stopped growing); the partial answer is included in the result');
      }
      return { query, answer: finalAnswer, mode: 'chat', isImageGeneration: isImageGen, generatedImages, images: [], sources: [], screenshot: screenshotPath, url: perplexityPage.url(), ...(incompleteAnswer ? { incomplete: true, reason: reason || 'timeout' } : {}) };
    }

    const pages = await browser.pages();
    // Reuse a tab only when it is already exactly on the target page: navigating
    // any other Perplexity tab (an unsent draft, a thread the user is reading)
    // would destroy their state.
    const targetUrl = flags.computer ? 'https://www.perplexity.ai/computer/new' : 'https://www.perplexity.ai/';
    // Compare origin + path only: the target URL carries no query string, so a tab
    // on the same path but with `?q=` / `?source=` / `?login=` would otherwise read
    // as "elsewhere" and get reloaded — wiping the very composer draft the reuse
    // exists to protect. A trailing slash is equally not a difference.
    const onTarget = (url) => {
      try {
        const a = new URL(url); const b = new URL(targetUrl);
        return a.origin === b.origin
          && a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '');
      } catch (e) { return url === targetUrl; }
    };
    let perplexityPage = pages.find(p => onTarget(p.url())) || null;
    const created = !perplexityPage;
    if (!perplexityPage) { perplexityPage = await browser.newPage(); openedPage = perplexityPage; }
    await perplexityPage.bringToFront();

    // Navigate only when the tab is not already there — a goto() on the URL it is
    // already showing reloads the page and discards any composer draft, which is
    // the exact state the reuse above protects. A tab we just created still has
    // to be navigated to.
    if (created || !onTarget(perplexityPage.url())) {
      await perplexityPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await sleep(flags.computer ? 3000 : 2000);

    await dismissModals(perplexityPage);
    if (flags.deep) await toggleDeepResearch(perplexityPage);

    const urlBeforeSubmit = perplexityPage.url();

    const input = await findInput(perplexityPage);
    if (!input) {
      try { const debugPath = path.join(OUTPUT_DIR, 'perplexity-debug-' + Date.now() + '-' + process.pid + '.png'); await perplexityPage.screenshot({ path: debugPath }); log('Debug screenshot: ' + debugPath); } catch (e) { log('Warning: debug screenshot also failed: ' + e.message); }
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

    const { text: answer, isImageGen, incomplete, reason } = await waitForAnswer(perplexityPage, timeoutMs, flags);
    let generatedImages = [];
    if (isImageGen) generatedImages = await waitAndDownloadImages(perplexityPage, 60000);

    let images = [];
    try { images = await perplexityPage.evaluate(() => { const imgs = document.querySelectorAll('[class*="prose"] img, [class*="markdown"] img, article img'); return Array.from(imgs).map(img => img.src).filter(src => src && !src.startsWith('data:')); }); } catch (e) { log('Warning: inline image extraction failed: ' + e.message); }

    let sources = [];
    try { sources = await perplexityPage.evaluate(() => { const links = document.querySelectorAll('[class*="source"] a, [class*="citation"] a'); return Array.from(links).slice(0, 10).map(a => ({ title: a.textContent ? a.textContent.trim() : '', url: a.href })).filter(s => s.url && !s.url.includes('perplexity.ai')); }); } catch (e) { log('Warning: source extraction failed: ' + e.message); }

    const ts = Date.now() + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    let screenshotPath = null;
    try { screenshotPath = path.join(OUTPUT_DIR, 'perplexity-result-' + ts + '.png'); await perplexityPage.screenshot({ path: screenshotPath, fullPage: false }); } catch (e) { log('Warning: could not take result screenshot: ' + e.message); }

    if (!answer && !isImageGen) {
      // Same contract as the chat path: partial/empty must never be presented
      // as a completed answer with exit 0.
      throw new Error('No answer extracted — timeout, login wall or empty response. Current URL: '
        + perplexityPage.url());
    }
    if (incomplete) {
      log('Warning: reporting the run as incomplete (timeout before the answer stopped growing); the partial answer is included in the result');
    }
    return { query, answer: answer || '[Image generated - see generatedImages]', mode: getModeLabel(flags), isImageGeneration: isImageGen, generatedImages, images, sources, screenshot: screenshotPath, url: perplexityPage.url(), ...(incomplete ? { incomplete: true, reason: reason || 'timeout' } : {}) };
  } finally {
    // Tabs we opened are ours to close: the old code only disconnected, so
    // every run leaked a tab (and its memory) into the long-lived browser.
    if (openedPage) { try { await openedPage.close(); } catch (e) {} }
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
  let openedPage = null;
  try {
    // protocolTimeout: without it a wedged CDP socket makes every call hang
    // forever instead of failing.
    browser = await puppeteerLib().connect({ browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 60000 });
    const pages = await browser.pages();
    // Reuse only a tab already on the Discover feed: navigating any other
    // Perplexity tab the user has open would destroy their state.
    let page = pages.find(p => p.url().startsWith('https://www.perplexity.ai/discover/'));
    if (!page) { page = await browser.newPage(); openedPage = page; }
    await page.bringToFront();

    const categories = category === 'all' ? DISCOVER_CATEGORIES : [category];
    const result = { mode: 'discover', generatedAt: new Date().toISOString(), categories: {}, errors: {} };
    for (const cat of categories) {
      log('Discover: scraping /' + cat);
      try {
        result.categories[cat] = await scrapeDiscoverCategory(page, cat, limit);
      } catch (e) {
        log('Warning: failed to scrape ' + cat + ': ' + e.message);
        // Record the failure: a swallowed [] is indistinguishable from
        // "genuinely no stories" for any caller reading the JSON.
        result.categories[cat] = [];
        result.errors[cat] = e.message;
      }
    }
    if (categories.length && Object.keys(result.errors).length === categories.length) {
      throw new Error('every discover category failed: ' + Object.values(result.errors).join(' | '));
    }
    return result;
  } finally {
    if (openedPage) { try { await openedPage.close(); } catch (e) {} }
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
  const oneLineQuery = String(query).replace(/\s*\n+\s*/g, ' ').trim();

  // Session path first: the Library list endpoint answers directly, with none of
  // the shell-rendering/overlay fragility of scraping the Library UI.
  try {
    const session = require('./session.js');
    const result = await session.searchHistory(oneLineQuery, { limit });
    // searchHistory resolves to {hits, truncated}; tolerate a bare array too.
    const hits = Array.isArray(result) ? result
      : (result && Array.isArray(result.hits) ? result.hits : []);
    log(`history: session search matched ${hits.length} thread(s)`);
    return {
      mode: 'history',
      query: oneLineQuery,
      count: hits.length,
      threads: hits,
      truncated: Boolean(result && result.truncated),
      screenshot: null,
      url: 'https://www.perplexity.ai/library',
    };
  } catch (e) {
    log('Warning: session history search failed (' + e.message + '); falling back to the Library UI');
  }

  let browser;
  let openedPage = null;
  try {
    // protocolTimeout: without it a wedged CDP socket makes every call hang
    // forever instead of failing.
    browser = await puppeteerLib().connect({ browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 60000 });
    const pages = await browser.pages();
    // Reuse only a tab already in the Library: navigating any other Perplexity
    // tab the user has open would destroy their state.
    let page = pages.find(p => p.url().startsWith('https://www.perplexity.ai/library'));
    if (!page) { page = await browser.newPage(); openedPage = page; }
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

    const ts = Date.now() + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    let screenshot = null;
    try { screenshot = path.join(OUTPUT_DIR, 'perplexity-history-' + ts + '-' + process.pid + '-' + Math.random().toString(36).slice(2,8) + '.png'); await page.screenshot({ path: screenshot, fullPage: false }); } catch (e) { log('Warning: could not take history screenshot: ' + e.message); }

    return { mode: 'history', query: oneLine, count: Math.min(rows.length, limit), threads: rows.slice(0, limit), screenshot, url: page.url() };
  } finally {
    if (openedPage) { try { await openedPage.close(); } catch (e) {} }
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
      // The partial answer is printed above (never dropped), but a run that never
      // reached a stable answer is not a success.
      process.exit(result.incomplete ? 1 : 0);
    } catch (err) {
      lastError = err;
      log('Attempt ' + (attempt + 1) + ' failed: ' + err.message);
      if (err.message.includes('--chat requires') || err.message.includes('Could not find follow-up') || err.message.includes('Could not connect') || err.message.includes('connect ECONNREFUSED')) break;
      // A chat follow-up is not idempotent: retrying posts the same question into
      // the thread again and pollutes it.
      if (flags.chat) break;
    }
  }
  console.error('ERROR: All attempts failed. Last error: ' + (lastError ? lastError.message : 'unknown'));
  // A failure that still holds content (a read-back that could not be attributed
  // to this submit) must not swallow it: the structured error on stderr and the
  // JSON result on stdout both carry it, clearly marked unverified, and the exit
  // code stays non-zero.
  if (lastError && lastError.partialResult) {
    console.error('ERROR: unverified partial result: ' + JSON.stringify(lastError.partialResult));
    console.log(JSON.stringify(lastError.partialResult, null, 2));
  }
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
