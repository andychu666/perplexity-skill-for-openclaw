'use strict';
// Session core: Chrome/CDP plumbing and the HTTP layer for Perplexity's internal
// endpoints — cookie reading, CSRF pairing, bounded reads and uniform failure
// classification. The endpoint verbs live in session-api.js; session.js
// re-exports both so callers keep requiring './session.js'.
//
// Cookies are never printed and never written to disk.

// Shared Perplexity session layer.
//
// The OpenClaw-managed Chrome profile already holds a signed-in Perplexity Pro
// session. Reading its cookies over CDP (and pairing the CSRF cookie with an
// `x-csrf-token` header) lets callers hit Perplexity's internal endpoints
// directly — no menu clicking, no composer typing, no waiting for a stream.
//
// Cookies are never printed and never written to disk.
//
// CommonJS so both perplexity-query.js (CJS) and the .mjs helpers can use it.

const { randomUUID } = require('node:crypto');

const CDP_URL = process.env.PERPLEXITY_CDP || 'http://127.0.0.1:18800';
const ORIGIN = 'https://www.perplexity.ai';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';
const API_VERSION = '2.18';
const CDP_TIMEOUT_MS = 15000;
const HTTP_TIMEOUT_MS = 60000; // ask streams can legitimately take a while
const MAX_BODY_BYTES = 16 * 1048576; // guard against a runaway buffered response

// Network.getCookies lives on a PAGE target: the browser-level endpoint only
// exposes Browser.*/Target.* domains.
async function getCookies() {
  // Node <21 has no global WebSocket; fail with a reason instead of a bare
  // ReferenceError.
  if (typeof WebSocket === 'undefined') {
    throw new Error('no global WebSocket (needs Node 21+) - cannot read the browser session');
  }

  const listRes = await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
  if (!listRes.ok) throw new Error(`CDP /json/list returned HTTP ${listRes.status}`);
  const targets = await listRes.json();
  if (!Array.isArray(targets)) throw new Error('CDP /json/list did not return an array');

  // Match the real host, not a substring: a tab on perplexity.ai.evil.com must
  // never be mistaken for the logged-in Perplexity session.
  const isPerplexityUrl = (u) => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      return host === 'perplexity.ai' || host === 'www.perplexity.ai' || host.endsWith('.perplexity.ai');
    } catch {
      return false;
    }
  };
  let page = targets.find((t) => t.type === 'page' && isPerplexityUrl(t.url || ''));
  if (!page) {
    // No fallback to an arbitrary tab: Network.getCookies is partitioned by
    // browser context, so an incognito/other-profile tab can answer with the
    // wrong (or no) jar.
    throw new Error('no Perplexity tab found in the OpenClaw browser; open https://www.perplexity.ai there first');
  }
  if (!page.webSocketDebuggerUrl) throw new Error('the Perplexity tab exposes no debugger socket');

  let ws;
  try {
    ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch (e) {
    // Must not escape the finally block as a bare ReferenceError.
    throw new Error(`could not create a CDP websocket: ${e.message}`);
  }
  ws.onerror = () => {};   // handled by the promises below; avoids an unhandled 'error'
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket handshake timed out')), CDP_TIMEOUT_MS);
      const done = (fn, value) => {
        clearTimeout(timer);
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        fn(value);
      };
      ws.onopen = () => done(resolve);
      ws.onclose = () => done(reject, new Error('CDP websocket closed during the handshake'));
      ws.onerror = () => done(reject, new Error('could not open a CDP websocket'));
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP getCookies timed out')), CDP_TIMEOUT_MS);
      // Settle once: late frames, a late timeout or a dropped socket must not
      // double-settle (and a socket drop must not hang until the timeout).
      const settle = (fn, value) => {
        clearTimeout(timer);
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        fn(value);
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; } // keepalive/partial frame
        if (!msg || msg.id !== 1) return;
        if (msg.error) settle(reject, new Error(JSON.stringify(msg.error)));
        else settle(resolve, (msg.result && msg.result.cookies) || []);
      };
      ws.onclose = () => settle(reject, new Error('CDP websocket closed before replying'));
      ws.onerror = () => settle(reject, new Error('CDP websocket errored before replying'));
      ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: [ORIGIN] } }));
    });
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}

function csrfToken(cookies) {
  if (!Array.isArray(cookies)) return null;
  // Prefer the exact cookie name; the regex is only a fallback.
  const hit = cookies.find((c) => c && c.name === 'next-auth.csrf-token')
    || cookies.find((c) => c && typeof c.name === 'string' && /csrf/i.test(c.name));
  if (!hit || typeof hit.value !== 'string') return null;
  return hit.value.split('|')[0] || null;
}

/** Cookie header value: skip malformed entries and strip anything that could
 *  inject a header separator. */
function cookieHeader(cookies) {
  const jar = Array.isArray(cookies) ? cookies : [];
  return jar
    .filter((c) => c && typeof c.name === 'string' && /^[\w.\-]+$/.test(c.name))
    .map((c) => `${c.name}=${String(c.value === null || c.value === undefined ? '' : c.value).replace(/[\r\n;]/g, '')}`)
    .join('; ');
}

async function internalFetch(pathname, cookies, init = {}) {
  const csrf = csrfToken(cookies);
  const res = await fetch(`${ORIGIN}${pathname}`, {
    ...init,
    redirect: 'manual',
    // Bounded: an unbounded fetch here would hang the caller forever. A caller
    // signal is combined with the timeout instead of replacing it.
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)])
      : AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: (() => {
      // Headers normalises case, so a caller passing `Cookie`/`X-CSRF-Token`
      // cannot slip past the guard below (HTTP header names are case-insensitive).
      const h = new Headers(init.headers || {});
      // Only fill in defaults the caller did not set: submitAsk asks for
      // text/event-stream, and clobbering it would break the stream.
      if (!h.has('user-agent')) h.set('user-agent', UA);
      if (!h.has('accept')) h.set('accept', 'application/json, text/plain, */*');
      if (init.body && !h.has('content-type')) h.set('content-type', 'application/json');
      // Auth headers are applied last: a caller must not be able to clobber
      // them (that would break the session or misattribute the request).
      h.set('cookie', cookieHeader(cookies));
      if (csrf) h.set('x-csrf-token', csrf);
      return h;
    })(),
  });
  // res.text() buffers the whole body: cap it so a runaway stream (or a huge
  // error page) cannot exhaust memory.
  const text = await readCapped(res, MAX_BODY_BYTES);
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON (e.g. an HTML error page) */ }
  // `redirect: 'manual'` makes undici return a spec-mandated opaque-redirect
  // response: status 0, type 'opaqueredirect', empty headers and body. That 0
  // would slip past every 3xx check below, so an expired session would look
  // like a plain HTTP 0 failure instead of a redirect. Normalise it to 302 so
  // failureReason() and isAuthFailure() classify it as the expired session it is.
  const opaqueRedirect = res.type === 'opaqueredirect';
  return { status: opaqueRedirect ? 302 : res.status, body, text };
}

async function readCapped(res, maxBytes) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    // Still enforce the cap: check the declared length before buffering, then
    // verify what was actually read.
    const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`response exceeded ${Math.round(maxBytes / 1048576)} MiB`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`response exceeded ${Math.round(maxBytes / 1048576)} MiB`);
    }
    return buf.toString('utf8');
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new Error(`response exceeded ${Math.round(maxBytes / 1048576)} MiB`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Uniform failure reporting: redirects (an expired session) and 401/403 are the
// cases a caller must be able to tell apart from a plain 500.
function failureReason(res, what) {
  // Slice before normalising: res.text can be megabytes on a runaway error page.
  const snippet = String(res.text || '').slice(0, 512).replace(/\s+/g, ' ').slice(0, 160);
  let err;
  if (res.status >= 300 && res.status < 400) {
    err = new Error(`${what} redirected (HTTP ${res.status}) - the Perplexity session looks expired; re-login in the OpenClaw browser`);
  } else if (res.status === 401 || res.status === 403) {
    err = new Error(`${what} refused (HTTP ${res.status}) - session may have expired or lack permission${snippet ? `: ${snippet}` : ''}`);
  } else {
    err = new Error(`${what} returned HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }
  // Structured status so callers classify on the code, not on message wording.
  err.status = res.status;
  return err;
}

/** True when a failure means the session is gone (auth/redirect) rather than a
 *  transient hiccup. Prefers the structured status; the message is a fallback. */
function isAuthFailure(e) {
  if (e && typeof e.status === 'number') {
    return e.status === 401 || e.status === 403 || (e.status >= 300 && e.status < 400);
  }
  return /401|403|redirect|expired|refused/i.test(String((e && e.message) || ''));
}

/** Coerce a caller-supplied number to a sane non-negative integer so it can be
 *  interpolated into a query string safely. */
function toInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

function threadSlug(value) {
  // String(null) is "null" and String(undefined) is "undefined": both would pass
  // the slug regex and request /rest/thread/null.
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`invalid thread reference: ${String(value).slice(0, 80)}`);
  }
  const raw = String(value).trim();
  if (!raw) throw new Error('invalid thread reference: empty');
  // Match the slug at a path boundary AND at the end of the value, so
  // "search/abc/def" is rejected instead of silently truncating to "abc".
  const m = raw.match(/(?:^|\/)(?:search|thread)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/);
  const slug = m ? m[1] : raw.replace(/^\/+|\/+$/g, '');
  // Reject anything that is not a plain slug: the value ends up in a URL path.
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) {
    throw new Error(`invalid thread reference: ${raw.slice(0, 80)}`);
  }
  return slug;
}

function parseSteps(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// Thread entries carry no plain answer string: `entry.text` is a JSON string of
// steps, and the FINAL step's content.answer is itself JSON like
// {"answer": "...", ...}. Unwrap both levels.
function entryAnswer(entry) {
  if (!entry) return '';
  for (const key of ['answer', 'markdown']) {
    if (typeof entry[key] === 'string' && entry[key].trim()) return entry[key];
  }
  const steps = parseSteps(entry.text);
  for (let i = steps.length - 1; i >= 0; i--) {
    const content = steps[i] && steps[i].content;
    if (!content || typeof content !== 'object') continue;
    const raw = content.answer !== undefined ? content.answer
      : content.markdown !== undefined ? content.markdown
      : content.text;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const inner = JSON.parse(raw);
      if (inner && typeof inner === 'object' && typeof inner.answer === 'string') return inner.answer;
    } catch { /* not JSON — use the string as-is */ }
    return raw;
  }
  return '';
}

module.exports = {
  CDP_URL,
  ORIGIN,
  UA,
  API_VERSION,
  HTTP_TIMEOUT_MS,
  MAX_BODY_BYTES,
  getCookies,
  csrfToken,
  cookieHeader,
  internalFetch,
  readCapped,
  failureReason,
  isAuthFailure,
  toInt,
  threadSlug,
  parseSteps,
  entryAnswer,
};
