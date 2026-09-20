#!/usr/bin/env node
// Reuse the logged-in Perplexity session instead of driving the UI.
//
// The OpenClaw-managed Chrome profile already holds a signed-in Perplexity Pro
// session. Reading its cookies over CDP (and pairing the CSRF cookie with an
// `x-csrf-token` header) lets us call Perplexity's internal endpoints directly —
// no menu clicking, no composer typing, no waiting for a stream to settle.
//
// Cookies are never printed and never written to disk by this script.
//
// Usage:
//   perplexity-session.mjs --whoami
//   perplexity-session.mjs --thread <thread-url-or-slug>
//   perplexity-session.mjs --history "<term>" [--limit N]
//   perplexity-session.mjs --json <action>
//
// Requires the OpenClaw browser to be running (default http://127.0.0.1:18800).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const session = require('./session.js');

function usage() {
  console.log(`Usage: perplexity-session.mjs --whoami
       perplexity-session.mjs [--json] --thread <thread-url-or-slug>
       perplexity-session.mjs [--json] --ask "<question>" [--thread <url>] [--model <id>]
       perplexity-session.mjs [--json] --history "<term>" [--limit N]
       perplexity-session.mjs [--json] --discover [--limit N]
       perplexity-session.mjs --models

Reuses the logged-in Perplexity session (cookies read over CDP) to query internal
endpoints without driving the UI. Cookies are never printed.`);
}

function parseArgs(argv) {
  const opts = { whoami: false, thread: null, history: null, ask: null, discover: false, models: false, model: null, json: false, limit: 10 };
  const NEEDS_VALUE = new Set(['--thread', '--history', '--library', '--ask', '--model', '--limit']);
  const BOOLEAN_FLAGS = new Set(['--whoami', '--json', '--discover', '--models', '--help', '-h']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (name) => {
      const v = argv[++i];
      // A missing value is an error. Another known flag is an error too. A bare
      // unknown flag (--bogus) is only an error for structured options:
      // --ask/--history take free text, so "--foo" can be a legitimate query.
      const freeText = name === '--ask' || name === '--history' || name === '--library';
      if (v === undefined || NEEDS_VALUE.has(v) || BOOLEAN_FLAGS.has(v)
          || (!freeText && /^--[a-z][a-z-]*$/.test(v))) {
        console.error(`Error: ${name} needs a value`);
        process.exit(2);
      }
      return v;
    };
    if (a === '--whoami') opts.whoami = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--thread') opts.thread = need(a);
    else if (a === '--history' || a === '--library') opts.history = need(a);
    else if (a === '--ask') opts.ask = need(a);
    else if (a === '--model') opts.model = need(a);
    else if (a === '--discover') opts.discover = true;
    else if (a === '--models') opts.models = true;
    else if (a === '--limit') {
      const raw = need(a);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) { console.error('Error: --limit needs a positive integer'); process.exit(2); }
      opts.limit = n;
    } else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`Error: unknown option ${a}`); process.exit(2); }
  }

  // Exactly one primary action per invocation: running several silently would do
  // hidden work (and print several unrelated reports). --thread alone is an
  // action; with --ask it is just its target. Compare against null, so an
  // explicitly empty value is validated instead of counting as "no action".
  for (const [name, value] of [['--thread', opts.thread], ['--ask', opts.ask], ['--history', opts.history], ['--model', opts.model]]) {
    if (value !== null && !String(value).trim()) {
      console.error(`Error: ${name} needs a non-empty value`);
      process.exit(2);
    }
  }
  const actions = [opts.whoami, opts.history !== null, opts.ask !== null, opts.discover, opts.models]
    .filter(Boolean).length + (opts.thread !== null && opts.ask === null ? 1 : 0);
  if (opts.model && !opts.ask) {
    // Checked before the action count: a lone --model must not fall through to
    // the generic usage error.
    console.error('Error: --model only applies to --ask');
    process.exit(2);
  }
  if (actions === 0) { usage(); process.exit(1); }
  if (actions > 1) {
    console.error('Error: pass exactly one action (--whoami | --thread | --ask | --history | --discover | --models)');
    process.exit(2);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

let cookies;
try {
  cookies = await session.getCookies();
} catch (e) {
  console.error(`Error: could not read the browser session (${e.message}). Is the OpenClaw browser running?`);
  process.exit(1);
}
if (!Array.isArray(cookies) || cookies.length === 0) {
  console.error('Error: no Perplexity cookies found — is the openclaw profile logged in?');
  process.exit(1);
}

const REDACT = Symbol('redact');
// The session helper returns the live cookie jar alongside its payload (the
// caller chains it into the next request), and thread entries carry per-thread
// `read_write_token`s that authorise follow-ups. No credential may reach stdout,
// logs or CI captures. Only real credentials are dropped: pagination cursors
// such as next_token stay, since they are not secrets.
const SECRET_KEY = /^(cookies?|csrf[a-z_]*|authorization|api_?key|jwt|session_?id|access_?token|refresh_?token|id_?token|[a-z_]*write_token|[a-z_]*secret|[a-z_]*password)$/i;
function withoutSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = withoutSecrets(v);
  }
  return out;
}
// Deep redaction: nested objects/arrays and numeric identifiers leak the same
// account data as top-level strings.
function redactValue(value) {
  if (typeof value === 'string' || typeof value === 'number') return '<redacted>';
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v);
    return out;
  }
  return value; // booleans/null carry no identity
}

if (opts.whoami) {
  let res;
  try {
    res = await session.internalFetch('/rest/user/info', cookies);
  } catch (e) {
    console.error(`Error: /rest/user/info request failed (${e.message})`);
    process.exit(1);
  }
  const { status, body } = res;
  if (status !== 200) {
    console.error(`Error: /rest/user/info returned HTTP ${status} (session may have expired)`);
    process.exit(1);
  }
  if (opts.json) {
    // /rest/user/info is account-scoped and carries identifiers (email, user id,
    // subscription details). Dump the shape, not the values — at any depth.
    console.log(JSON.stringify(redactValue(body || {}), null, 2));
  } else {
    console.log('session: OK');
    console.log('cookies:', cookies.length, '| csrf:', session.csrfToken(cookies) ? 'present' : 'missing');
    console.log('host:', (body && body.home_host) || '(unknown)');
  }
}

// --thread is the target of --ask, not a second action: run this only when no ask
// was requested, or the thread would be fetched and printed twice.
if (opts.thread && !opts.ask) {
  let result;
  try {
    result = await session.getThread(opts.thread, { cookies });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  const { thread, slug } = result;
  if (!thread || typeof thread !== 'object') {
    console.error('Error: the thread response was not an object');
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify(withoutSecrets(thread), null, 2));
  } else {
    const entries = Array.isArray(thread.entries) ? thread.entries : [];
    console.log('thread:', thread.slug || slug);
    console.log('title:', thread.title || '(untitled)');
    console.log('entries:', entries.length);
    for (const e of entries.slice(-3)) {
      const q = (e.query_str || e.query || '').replace(/\s+/g, ' ').slice(0, 70);
      const a = String(session.entryAnswer(e) || '').replace(/\s+/g, ' ').slice(0, 90);
      console.log(`  Q: ${q}`);
      if (a) console.log(`  A: ${a}${a.length >= 90 ? '...' : ''}`);
    }
  }
}

if (opts.ask) {
  let result;
  try {
    result = await session.submitAsk(opts.ask, { threadUrl: opts.thread, cookies, modelPreference: opts.model || undefined });
  } catch (e) {
    console.error(`Error: session ask failed (${e.message})`);
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify(withoutSecrets({ query: opts.ask, slug: result.slug, answer: result.answer }), null, 2));
  } else {
    console.log(result.answer || '[no answer]');
    if (result.slug) console.log(`\nthread: ${session.ORIGIN}/search/${result.slug}`);
  }
}

if (opts.models) {
  let info;
  try {
    info = await session.listModels({ cookies });
  } catch (e) {
    console.error(`Error: could not list models (${e.message})`);
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify(withoutSecrets(info), null, 2));
  } else {
    const models = Array.isArray(info.models) ? info.models : [];
    console.log(`models: ${models.length}`);
    for (const m of models) {
      console.log(`  ${String(m.id).padEnd(28)} ${m.label}${m.mode ? `  [${m.mode}]` : ''}`);
    }
    if (info.defaults) console.log('defaults:', JSON.stringify(info.defaults));
  }
}

if (opts.discover) {
  let feed;
  try {
    feed = await session.discoverFeed({ limit: opts.limit, cookies });
  } catch (e) {
    console.error(`Error: discover feed failed (${e.message})`);
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify(withoutSecrets(feed), null, 2));
  } else {
    const items = Array.isArray(feed.items) ? feed.items : [];
    console.log(`discover: ${items.length} item(s)`);
    for (const s of items) {
      console.log(`  - ${s.title}`);
      if (s.summary) console.log(`    ${s.summary.replace(/\s+/g, ' ').slice(0, 110)}`);
      if (s.url) console.log(`    ${s.url}`);
    }
  }
}

if (opts.history) {
  let result;
  try {
    result = await session.searchHistory(opts.history, { limit: opts.limit, cookies });
  } catch (e) {
    console.error(`Error: history search failed (${e.message})`);
    process.exit(1);
  }
  // searchHistory returns {hits, truncated}; tolerate a bare array too.
  const results = Array.isArray(result) ? result
    : (result && Array.isArray(result.hits) ? result.hits : []);
  const truncated = Boolean(result && result.truncated);
  if (truncated) {
    console.error('Warning: history scan stopped early; results may be incomplete');
  }
  if (opts.json) {
    console.log(JSON.stringify(withoutSecrets({ term: opts.history, count: results.length, threads: results, truncated }), null, 2));
  } else {
    console.log(`history: "${opts.history}" -> ${results.length} thread(s)`);
    for (const t of results) {
      const when = (t.updated_at || '').slice(0, 19).replace('T', ' ');
      console.log(`  - ${String(t.title || '(untitled)').slice(0, 70)}`);
      console.log(`    ${t.url || '(no url)'}${when ? `  (${when})` : ''}`);
    }
  }
}
