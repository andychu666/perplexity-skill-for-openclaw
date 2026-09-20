#!/usr/bin/env node
// Deep research via the official Perplexity Agent API (API-first path for --deep).
//
// Why: driving the Deep Research mode through the browser UI is fragile (the mode
// moved into the composer's "/" menu and must be selected on an empty composer),
// and a streamed report is easy to capture half-finished. The Agent API returns a
// finished report, supports presets, and can run as a background job.
//
// Usage:
//   perplexity-research.mjs --query "..." [--preset fast|low|medium|high|xhigh]
//   perplexity-research.mjs --resume <job_id>
//
// Options:
//   --preset        default medium            (high/xhigh run in background)
//   --background    force a background job
//   --resume ID     collect an existing background job instead of starting one
//   --output-dir    default $PPLX_OUTPUT_DIR or ./research-output
//   --stdout-preview N   report chars on stdout (default 1500, 0 = full)
//   --timeout SEC   default 900 for high/xhigh, else 120
//   --poll-interval SEC  background poll interval (default 10)

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const API_URL = 'https://api.perplexity.ai/v1/agent';
const PRESETS = ['fast', 'low', 'medium', 'high', 'xhigh'];
const BACKGROUND_PRESETS = new Set(['high', 'xhigh']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'incomplete']);
// Any status we understand is terminal for polling purposes. TERMINAL alone was
// narrower than FAIL_STATES/OK_STATES, so a job reporting `error`, `expired`,
// `canceled` or `success` fell through to the sleep branch and polled until the
// whole --timeout budget was burnt instead of failing fast (or finishing).
// Terminal states that are NOT a successful job. The old code treated every
// TERMINAL state as done, so a failed job wrote an empty report and exited 0.
const FAIL_STATES = new Set(['failed', 'cancelled', 'canceled', 'incomplete', 'error', 'expired']);
const OK_STATES = new Set(['completed', 'success', 'finished', 'succeeded']);
const JOB_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_TIMEOUT_MS = 120000;
const RAW_OUTPUT_CAP = 2 * 1048576; // do not copy a multi-MB payload verbatim

function die(code, message, hint) {
  console.error(JSON.stringify({ error: { code, message, hint } }));
  process.exit(1);
}

// Numeric CLI options used to be parsed with a bare Number(): `--timeout x`
// became NaN (so the run never timed out) and `--poll-interval x` became 0
// (a busy loop hammering the API). Validate once, here.
function argNumber(name, raw, { min = 0 } = {}) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    die('ARGUMENT_ERROR', `${name} needs a whole number >= ${min}, got ${JSON.stringify(raw)}`, 'See --help.');
  }
  return n;
}

function jobIdOf(payload, fallback) {
  return (payload && payload.id) || fallback || 'unknown';
}

/** Reject a job that ended in a non-success terminal state. Used on the sync
 *  path, which may legitimately carry no status field at all. */
function assertNotFailed(payload, fallbackId) {
  const st = payload && typeof payload.status === 'string' ? payload.status : null;
  if (st && FAIL_STATES.has(st)) {
    die('JOB_FAILED', `job ${jobIdOf(payload, fallbackId)} ended as ${st}`,
      `Inspect it with --resume ${jobIdOf(payload, fallbackId)}`);
  }
  return payload;
}

/** The poll loop only returns on a terminal state, so a terminal state that is
 *  not a success - or one we do not recognise - must fail loudly rather than
 *  yield an empty report with exit 0. */
function assertCompleted(payload, fallbackId) {
  const st = payload && typeof payload.status === 'string' ? payload.status : null;
  const id = jobIdOf(payload, fallbackId);
  if (st && FAIL_STATES.has(st)) {
    die('JOB_FAILED', `job ${id} ended as ${st}`, `Inspect it with --resume ${id}`);
  }
  if (!st || !OK_STATES.has(st)) {
    die('JOB_STATE', `job ${id} reported ${st === null ? 'no status' : `an unrecognised status: ${st}`}`,
      `Collect it again with --resume ${id}`);
  }
  return payload;
}

function parseArgs(argv) {
  const opts = {
    query: null, preset: 'medium', resume: null, background: false,
    outputDir: process.env.PPLX_OUTPUT_DIR || './research-output',
    stdoutPreview: 1500, timeout: null, pollInterval: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (name) => {
      const v = argv[++i];
      if (v === undefined) die('ARGUMENT_ERROR', `${name} needs a value`, 'See --help.');
      return v;
    };
    if (a === '--query' || a === '-q') opts.query = need(a);
    else if (a === '--preset') opts.preset = need(a);
    else if (a === '--resume') opts.resume = need(a);
    else if (a === '--background') opts.background = true;
    else if (a === '--output-dir') opts.outputDir = need(a);
    else if (a === '--stdout-preview') opts.stdoutPreview = argNumber(a, need(a), { min: 0 });
    else if (a === '--timeout') opts.timeout = argNumber(a, need(a), { min: 1 });
    else if (a === '--poll-interval') opts.pollInterval = argNumber(a, need(a), { min: 1 });
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else die('ARGUMENT_ERROR', `unknown option ${a}`, 'See --help.');
  }
  if (!opts.query && !opts.resume) die('ARGUMENT_ERROR', 'either --query or --resume is required', 'See --help.');
  if (opts.resume && !JOB_ID.test(opts.resume)) {
    die('ARGUMENT_ERROR', '--resume must be a job id (letters, digits, . _ : -)', 'See --help.');
  }
  if (!PRESETS.includes(opts.preset)) die('ARGUMENT_ERROR', `--preset must be one of ${PRESETS.join('|')}`, 'See --help.');
  // Collecting an existing background job is the slow path: it needs the long
  // budget even when the preset text says medium.
  if (opts.timeout === null) opts.timeout = (opts.resume || BACKGROUND_PRESETS.has(opts.preset)) ? 900 : 120;
  if (opts.background === false && BACKGROUND_PRESETS.has(opts.preset)) opts.background = true;
  return opts;
}

function usage() {
  console.log(`Usage: perplexity-research.mjs --query "..." [--preset ${PRESETS.join('|')}]
       perplexity-research.mjs --resume <job_id>

Presets: fast (seconds) · low (10-30s) · medium · high (minutes) · xhigh
high/xhigh run as background jobs and can be collected later with --resume.
The full report is written to --output-dir; stdout gets a preview + saved paths.`);
}

const opts = parseArgs(process.argv.slice(2));
const apiKey = process.env["PERPLEXITY_API_KEY"];
if (!apiKey) die('NO_API_KEY', 'PERPLEXITY_API_KEY environment variable not set', 'export PERPLEXITY_API_KEY=pplx-...');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    // A network failure must keep the structured error contract: an unhandled
    // rejection used to crash the run and lose the resume hint.
    const why = e && e.name === 'AbortError'
      ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : (e && e.message) || String(e);
    die('NETWORK_ERROR', `${method} ${url} failed: ${why}`, 'Check connectivity and the API key, then retry.');
  }
  try {
    let text;
    try {
      text = await res.text();
    } catch (e) {
      // A body read can fail on its own (abort mid-body, connection reset) and
      // must keep the JSON error contract instead of surfacing as an unhandled
      // rejection inside the caller's poll loop.
      const why = e && e.name === 'AbortError'
        ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : (e && e.message) || String(e);
      die('NETWORK_ERROR', `${method} ${url} body read failed: ${why}`, 'Check connectivity and retry.');
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function reportText(payload) {
  const out = payload && payload.output;
  if (!Array.isArray(out)) return '';
  for (let i = out.length - 1; i >= 0; i--) {
    const item = out[i];
    if (item && item.type === 'message' && Array.isArray(item.content)) {
      const text = item.content
        .filter((c) => c && (c.type === 'output_text' || typeof c.text === 'string'))
        .map((c) => c.text || '')
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

function sources(payload) {
  const out = (payload && payload.output) || [];
  const rows = [];
  for (const item of out) {
    if (item && item.type === 'search_results' && Array.isArray(item.results)) {
      for (const r of item.results) {
        // The API can put a null in the list; dereferencing it crashed a
        // finished (billed) run and broke the JSON error contract.
        if (!r || typeof r !== 'object') continue;
        rows.push({ title: r.title || '', url: r.url || '', snippet: r.snippet || '' });
      }
    }
  }
  return rows;
}

function slugify(text) {
  return (text || 'research').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'research';
}

async function poll(jobId, deadline) {
  let delay = Math.max(2, opts.pollInterval) * 1000;
  for (;;) {
    if (Date.now() > deadline) {
      die('TIMEOUT', `job ${jobId} did not finish within ${opts.timeout}s`,
        `The server-side job keeps running; collect it with --resume ${jobId}`);
    }
    const { status, json } = await request('GET', `${API_URL}/${encodeURIComponent(jobId)}`);
    if (status === 429 || status >= 500) {
      // Rate limited / transient: back off instead of failing the run.
      // Clamp to the remaining budget so --timeout is actually honoured.
      await sleep(Math.max(0, Math.min(delay, deadline - Date.now())));
      delay = Math.min(delay * 1.5, 30000);
      continue;
    }
    if (status >= 400 || !json) {
      // Name the job in the hint: without it an automation holding the id could
      // not collect the orphaned (billed) server-side job.
      die('API_ERROR', `poll failed with HTTP ${status} for job ${jobId}`,
        `Retry with --resume ${jobId}`);
    }
    if (TERMINAL.has(json.status) || FAIL_STATES.has(json.status) || OK_STATES.has(json.status)) {
      return assertCompleted(json, jobId);
    }
    process.stderr.write(`[research] job ${jobId}: ${json.status}\n`);
    await sleep(Math.max(0, Math.min(delay, deadline - Date.now())));
  }
}

const startedAt = new Date();
const outDir = resolve(opts.outputDir);
let payload;
if (opts.resume) {
  payload = await poll(opts.resume, Date.now() + opts.timeout * 1000);
} else {
  const body = { input: opts.query, preset: opts.preset };
  if (opts.background) body.background = true;
  const { status, json, text } = await request('POST', API_URL, body);
  if (status >= 400 || !json) {
    die('API_ERROR', `Agent API returned HTTP ${status}: ${(text || '').slice(0, 300)}`,
      'Check the API key and preset.');
  }
  assertNotFailed(json, null);
  // The id becomes a filename below, so it must match the allowed charset
  // before it is ever joined into a path.
  if (json.id !== undefined && json.id !== null && !JOB_ID.test(String(json.id))) {
    die('API_ERROR', 'server returned a malformed job id',
      'Refusing to use an unvalidated id as a filename; re-run the request.');
  }
  if (opts.background) {
    if (!json.id) die('API_ERROR', 'background job started without a job id',
      'Nothing to collect; re-run the request.');
    // Persist and announce the id immediately: a job that is only in memory
    // becomes an orphaned (billed) run the moment this process dies.
    process.stderr.write(`[research] job ${json.id} started; collect with --resume ${json.id}\n`);
    try {
      const dir = outDir;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `.job-${json.id}.json`),
        JSON.stringify({ job_id: json.id, started_at: startedAt.toISOString(), preset: opts.preset }) + '\n', 'utf8');
    } catch (e) {
      process.stderr.write(`[research] could not persist the job id: ${e && e.message}\n`);
    }
    payload = await poll(json.id, Date.now() + opts.timeout * 1000);
  } else if (json.status && !OK_STATES.has(json.status)) {
    // A synchronous POST can still answer non-terminal (the API may accept the
    // request and hand back a job id). The old code took any non-failed status
    // as a finished report, so partial output was written as complete.
    if (!json.id) die('JOB_STATE', `request reported ${json.status} without a job id`,
      'Re-run the request.');
    process.stderr.write(`[research] job ${json.id} accepted; collecting with --resume ${json.id}\n`);
    payload = await poll(json.id, Date.now() + opts.timeout * 1000);
  } else {
    payload = json;
  }
}

const report = reportText(payload);
const jobId = payload.id || opts.resume || null;
if (!report) {
  // A finished job with no extractable report means the response shape moved,
  // not that the answer was empty.
  die('EMPTY_REPORT', `job ${jobId || 'unknown'} finished without a report`,
    'The response shape may have changed; inspect the raw payload before relying on this.');
}
const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
const cost = (payload.usage && payload.usage.cost) || null;

const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Two runs in the same second used to overwrite each other's report (they are
// billed). Pick the first free name and write through a temp file + rename so a
// crash cannot leave a half-written result.
// Reserve the name with an exclusive create instead of pre-checking with
// existsSync: the check-then-write gap let two concurrent runs with the same
// query pick the same base and silently overwrite each other's billed report.
function writeReserved(dir, prefix, jsonText, mdText) {
  for (let n = 0; n < 1000; n++) {
    const base = join(dir, n === 0 ? prefix : `${prefix}-${n}`);
    try {
      writeFileSync(`${base}.json`, jsonText, { flag: 'wx' });
      try {
        writeFileSync(`${base}.md`, mdText, { flag: 'wx' });
      } catch (e) {
        try { rmSync(`${base}.json`, { force: true }); } catch { /* best effort */ }
        throw e;
      }
      return base;
    } catch (e) {
      if (e && e.code === 'EEXIST') continue;
      throw e;
    }
  }
  die('OUTPUT_ERROR', 'could not find a free output filename', 'Clean up the output directory.');
}

const rawJson = JSON.stringify(payload.output || null);
const rawOutput = rawJson && rawJson.length > RAW_OUTPUT_CAP
  ? { truncated: true, bytes: rawJson.length, preview: rawJson.slice(0, RAW_OUTPUT_CAP) }
  : (payload.output || null);
const record = {
  query: opts.query, preset: opts.preset, job_id: jobId,
  started_at: startedAt.toISOString(), elapsed_seconds: Number(elapsed),
  report, sources: sources(payload), usage: payload.usage || null,
  raw_output: rawOutput,
};

let base;
try {
  mkdirSync(outDir, { recursive: true });
  base = writeReserved(outDir, `${slugify(opts.query || jobId)}-${stamp}`,
    JSON.stringify(record, null, 2),
    `# ${opts.query || jobId}\n\n_preset: ${opts.preset} · ${elapsed}s · ${jobId || 'n/a'}_\n\n${report}\n`);
} catch (e) {
  // Keep the JSON error contract: an unwritable output directory must not
  // surface as a raw node stack trace.
  die('OUTPUT_ERROR', `could not write the report: ${(e && e.message) || e}`,
    `Check permissions on ${outDir}.`);
}

const preview = opts.stdoutPreview === 0 ? report : report.slice(0, opts.stdoutPreview);
console.log(preview);
if (opts.stdoutPreview !== 0 && report.length > opts.stdoutPreview) {
  console.log(`\n… [${report.length - opts.stdoutPreview} more chars]`);
}
console.log(`\nsaved_to:\n  ${base}.md\n  ${base}.json`);
if (cost && cost.currency) {
  const total = Object.entries(cost)
    .filter(([k, v]) => typeof v === 'number' && k.endsWith('_cost') && !k.endsWith('_details'))
    .reduce((sum, [, v]) => sum + v, 0);
  console.log(`cost: ~${total.toFixed(4)} ${cost.currency}`);
}
