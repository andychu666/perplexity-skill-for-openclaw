'use strict';
// Session API verbs: threads, ask, history, discover and models. All transport
// (CDP cookies, CSRF pairing, bounded fetch, failure classification) comes from
// session-core.js — this module is the endpoint surface only.
const { randomUUID } = require('node:crypto'); // submitAsk's frontend_uuid
const {
  API_VERSION, ORIGIN, getCookies, internalFetch, failureReason,
  isAuthFailure, toInt, threadSlug, entryAnswer,
} = require('./session-core.js');

// --- Shared response guard --------------------------------------------------
// Every fetcher goes through assertBody, so a 200 that does not carry the
// expected payload is a loud failure (SHAPE) instead of a silent empty result.
// An expired session used to look like "no data" on three separate paths.
function shapeError(what, detail) {
  const err = new Error(`${what}: unexpected response shape (${detail}) - the endpoint may have changed`);
  err.code = 'SHAPE';
  return err;
}

function assertBody(res, what, ok, detail) {
  if (res.status !== 200) throw failureReason(res, what);
  if (!ok(res.body)) throw shapeError(what, detail);
  return res.body;
}

// --- Per-thread ask lock ----------------------------------------------------
// Two overlapping asks on the same thread both read the same "last entry"
// token and then race, so one answer can be written into the other's slot.
const threadLocks = new Map();

function withThreadLock(key, fn) {
  const prev = threadLocks.get(key) || Promise.resolve();
  // Run fn after prev settles, but never hand prev's settlement value to it:
  // a predecessor's rejection must not arrive as fn's first argument.
  const run = prev.then(() => fn(), () => fn());
  // `run.catch()` allocates a NEW promise every time it is called, so storing
  // one and comparing against another in finally never matched and the Map
  // entry was never deleted (unbounded lock-table growth). Keep the exact
  // guarded promise we stored.
  const guarded = run.catch(() => {}); // never poison the chain
  threadLocks.set(key, guarded);
  return run.finally(() => {
    if (threadLocks.get(key) === guarded) threadLocks.delete(key);
  });
}

async function listThreads({ cookies, limit = 10, offset = 0 } = {}) {
  const jar = cookies || await getCookies();
  const safeLimit = toInt(limit, 10);
  const safeOffset = toInt(offset, 0);
  const res = await internalFetch('/rest/thread/list_ask_threads', jar, {
    method: 'POST',
    body: JSON.stringify({ limit: safeLimit, offset: safeOffset, source: 'default' }),
  });
  const threads = assertBody(res, 'thread list', Array.isArray, 'expected an array of threads');
  return { cookies: jar, threads };
}

async function searchHistory(term, { limit = 10, pages = 3, perPage = 200 } = {}) {
  const jar = await getCookies();
  const needle = String(term || '').toLowerCase().trim();
  // Bounded: unclamped pages/limit let one call fire hundreds of requests and
  // hold the process for hours.
  // toInt accepts 0, and pages:0 / perPage:0 (or limit:0) skip the scan
  // entirely yet still return a "complete" {hits:[], truncated:false} result.
  // Clamp the floor to 1 so an empty answer always means "scanned and found none".
  const safeLimit = Math.max(1, Math.min(toInt(limit, 10), 500));
  const safePages = Math.max(1, Math.min(toInt(pages, 3), 10));
  const safePerPage = Math.max(1, Math.min(toInt(perPage, 200), 200));
  // No server-side thread search exists (list_ask_threads ignores a `query`
  // field, and the GraphQL endpoint only accepts allow-listed operations), so
  // scan large pages instead: the endpoint serves up to 200 per request.
  const hits = [];
  let skipped = 0;
  let truncated = false;
  let scanError = null;
  const MAX_SCAN = 600;

  for (let page = 0; page < safePages; page++) {
    let threads;
    try {
      ({ threads } = await listThreads({ cookies: jar, limit: safePerPage, offset: page * safePerPage }));
    } catch (e) {
      // A transient failure mid-scan can keep the partial hits, but an expired
      // session (or any auth/redirect failure) must surface, not look like
      // "no more results".
      if (page === 0 || isAuthFailure(e)) throw e;
      // Partial AND reported: a mid-scan failure must not look like a scan that
      // finished and simply found nothing. Keep the reason for the caller.
      truncated = true;
      scanError = scanError || (e && e.message ? e.message : String(e));
      break;
    }
    if (threads.length === 0) break;
    let hitCap = false;
    for (const t of threads) {
      if (skipped >= MAX_SCAN) { hitCap = true; break; }
      skipped++;
      const haystack = `${(t && t.title) || ''} ${(t && t.query_str) || ''} ${(t && t.answer_preview) || ''}`.toLowerCase();
      if (t && typeof t === 'object' && (!needle || haystack.includes(needle))) {
        hits.push({
          title: t.title || '(untitled)',
          slug: t.slug,
          url: `${ORIGIN}/search/${t.slug}`,
          updated_at: t.last_query_datetime || null,
          query_count: t.query_count || null,
        });
      }
    }
    if (hitCap) truncated = true;
    if (hitCap || hits.length >= safeLimit) {
      // Stopping for the caller's limit (or the scan cap) while pages are
      // still left means matches may remain unscanned: the result is partial
      // even though it is exactly what was asked for. On the last page there
      // is nothing left to scan, so it stays complete.
      if (page < safePages - 1) truncated = true;
      break;
    }
    // The loop can also end by exhausting the page budget. If that last page
    // came back full, more threads may exist beyond what we scanned, so the
    // result is partial and the caller must be told.
    if (page === safePages - 1 && threads.length >= safePerPage) truncated = true;
  }
  // Dropping matches to honour the caller's limit is itself a partial result.
  if (hits.length > safeLimit) truncated = true;
  // An object, not a decorated array: JSON.stringify drops non-index array
  // properties, so the truncation flag would vanish for API consumers.
  return { hits: hits.slice(0, safeLimit), truncated, ...(scanError ? { error: scanError } : {}) };
}
async function getThread(slugOrUrl, { cookies } = {}) {
  const jar = cookies || await getCookies();
  const slug = threadSlug(slugOrUrl);
  const res = await internalFetch(`/rest/thread/${slug}`, jar);
  const thread = assertBody(res, `thread ${slug}`,
    (b) => b && typeof b === 'object' && Array.isArray(b.entries),
    'expected a thread object with an entries array');
  return { cookies: jar, slug, thread };
}

// Latest answer text in a thread — used to read back a chat follow-up without
// scraping the DOM.
async function latestAnswer(slugOrUrl, { cookies, minEntries = 1 } = {}) {
  const { thread, slug } = await getThread(slugOrUrl, { cookies });
  const entries = Array.isArray(thread.entries) ? thread.entries : [];
  // A non-numeric minEntries made every later comparison NaN, so the walk-back
  // loop never ran and the call silently reported "no answer". Coerce once.
  const min = Math.max(1, toInt(minEntries, 1));
  if (entries.length < min) return { slug, answer: '', entries: entries.length };
  // Never walk back past the entries the caller had already seen: a new entry
  // that is not filled in yet would otherwise surface the *previous* turn's
  // answer as this turn's reply.
  const start = Math.max(0, Math.min(min - 1, entries.length - 1));
  for (let i = entries.length - 1; i >= start; i--) {
    const answer = entryAnswer(entries[i]);
    if (answer) return { slug, answer, entries: entries.length };
  }
  return { slug, answer: '', entries: entries.length };
}

// Block use cases the web client advertises. They are passed through verbatim
// from a captured browser request so the server returns the same block set.
const ASK_BLOCK_USE_CASES = [
  'answer_modes', 'media_items', 'inline_entity_cards', 'place_widgets',
  'finance_widgets', 'sports_widgets', 'news_widgets', 'shopping_widgets',
  'jobs_widgets', 'search_result_widgets', 'inline_images', 'inline_assets',
  'placeholder_cards', 'diff_blocks', 'entity_group_v2', 'refinement_filters',
  'canvas_mode', 'maps_preview', 'answer_tabs', 'price_comparison_widgets',
  'preserve_latex', 'generic_onboarding_widgets', 'in_context_suggestions',
  'pending_followups', 'inline_claims', 'unified_assets', 'workflow_steps',
  'workflow_widgets', 'navigation_results', 'background_agents',
];

// The ask stream is a series of `data:` lines carrying JSON. Per the SSE spec a
// frame may spread its payload over several `data:` lines (joined with \n), but
// this endpoint also emits one JSON object per line — so try the joined form
// first and fall back to per-line parsing.
function parseAskStream(text) {
  const answers = [];
  let slug = null;
  let streamError = null;

  // The stream re-sends a block as it grows (and may send several distinct
  // blocks), so a naive append duplicates the answer and keeping only the last
  // one truncates it. Track the most complete version of each block: exact
  // repeats are dropped, a longer version of the last block replaces it in
  // place, and a shorter (or equal) prefix of the last block is a lagging /
  // retried retransmit of that same block and is dropped.
  const keep = (raw) => {
    const t = String(raw || '').trim();
    if (!t) return;
    if (answers.includes(t)) return;
    // Only the LAST block is compared: the stream re-sends the same block as it
    // grows, so a longer version of the block we just appended replaces it in
    // place, while a shorter version of it is an out-of-order retransmit that
    // must not be appended as a duplicate. Comparing against every earlier
    // block (the old rule) could delete a distinct block that merely happens to
    // be a prefix of a later one.
    const last = answers.length - 1;
    if (last >= 0) {
      const prev = answers[last];
      if (t.startsWith(prev)) { answers[last] = t; return; }
      if (prev.startsWith(t)) return;
    }
    answers.push(t);
  };

  const handlePayload = (payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (payload.thread_url_slug) slug = payload.thread_url_slug;
    // A stream-level failure arrives as a normal 200 frame carrying `error`;
    // without this it looks like "no answer yet" and the ask is reported empty.
    if (payload.error) {
      streamError = typeof payload.error === 'string'
        ? payload.error
        : (payload.error.message || JSON.stringify(payload.error));
      return;
    }
    const blocks = payload.blocks;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      const markdown = block && block.markdown_block;
      if (markdown && typeof markdown.answer === 'string') keep(markdown.answer);
    }
  };

  const consume = (raw) => {
    if (!raw || raw === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    handlePayload(payload);
  };

  // Blank line separates frames; a frame's payload is the joined data lines.
  for (const frame of String(text || '').split(/\r?\n\r?\n/)) {
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) continue;
    if (dataLines.length === 1) {
      consume(dataLines[0].trim());
      continue;
    }
    const joined = dataLines.join('\n').trim();
    let parsedJoined = false;
    try { JSON.parse(joined); parsedJoined = true; } catch { /* not one object */ }
    if (parsedJoined) consume(joined);
    else for (const line of dataLines) consume(line.trim());
  }
  return { answer: answers.join('\n\n'), slug, error: streamError };
}

// Submit a query entirely through the session layer — no browser UI, so none of
// the composer/menu/streaming fragility applies. Thread-scoped tokens come from
// the thread itself.
// Serialised per thread: see withThreadLock. Without a thread there is nothing
// to interleave, so this is a straight pass-through.
async function submitAsk(query, opts = {}) {
  const { threadUrl = null } = opts;
  if (!threadUrl) return submitAskOnce(query, opts);
  return withThreadLock(threadSlug(threadUrl), () => submitAskOnce(query, opts));
}

async function submitAskOnce(query, { threadUrl = null, cookies, modelPreference = 'pplx_alpha', mode = 'copilot' } = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('query must be a non-empty string');
  }
  const jar = cookies || await getCookies();
  let last = {};
  let slug = null;
  let entriesBefore = 0;
  if (threadUrl) {
    const got = await getThread(threadUrl, { cookies: jar });
    slug = got.slug;
    const entries = Array.isArray(got.thread.entries) ? got.thread.entries : [];
    entriesBefore = entries.length;
    last = entries[entries.length - 1] || {};
  }

  const params = {
    last_backend_uuid: last.backend_uuid || null,
    read_write_token: last.read_write_token || null,
    attachments: [],
    language: process.env.PPLX_LANGUAGE || 'en-US',
    timezone: process.env.PPLX_TIMEZONE || 'UTC',
    search_focus: 'internet',
    sources: ['web'],
    frontend_uuid: randomUUID(),
    mode,
    model_preference: modelPreference,
    is_related_query: false,
    is_sponsored: false,
    prompt_source: 'user',
    // Only a real thread continuation is a follow-up; a new thread must not claim
    // to be one (the server relies on this for placement).
    query_source: threadUrl && last.read_write_token ? 'followup' : 'user',
    is_incognito: false,
    time_from_first_type: 500,
    local_search_enabled: false,
    use_schematized_api: true,
    send_back_text_in_streaming_api: false,
    supported_block_use_cases: ASK_BLOCK_USE_CASES,
    source: 'default',
    always_search_override: false,
    override_no_search: false,
    version: API_VERSION,
  };

  const res = await internalFetch('/rest/sse/perplexity_ask', jar, {
    method: 'POST',
    headers: { accept: 'text/event-stream' },
    body: JSON.stringify({ params, query_str: query }),
  });
  if (res.status !== 200) throw failureReason(res, 'perplexity_ask');
  const parsed = parseAskStream(res.text);
  if (parsed.error) throw new Error(`perplexity_ask stream error: ${parsed.error}`);
  let answer = parsed.answer;
  const answerSlug = parsed.slug || slug;
  if ((!answer || !answer.trim()) && answerSlug) {
    // The stream sometimes carries only the plan/search blocks; the finished text
    // then lands on the thread itself, so read it back before giving up.
    try {
      // Require a NEW entry: if the ask produced none, the read-back would
      // otherwise return the previous turn's answer as if it were the reply.
      const read = await latestAnswer(answerSlug, { cookies: jar, minEntries: entriesBefore + 1 });
      if (read.answer && read.answer.trim()) answer = read.answer;
    } catch (e) {
      // No silent fallback here: a read-back that throws (HTTP 500, timeout,
      // network error) is a real failure, and reporting it as an empty answer
      // would hide it. `latestAnswer` signals "no answer yet" by returning an
      // empty string, so reaching this catch always means the read broke.
      throw e;
    }
  }
  if (!answer || !answer.trim()) {
    // An empty answer after the read-back is a failure, not a success: it is how
    // an expired session or a rate limit used to masquerade as "no answer yet".
    const err = new Error('ask produced no answer (empty stream and empty thread read-back) - session may be expired or rate limited');
    err.code = 'EMPTY_ANSWER';
    throw err;
  }
  return { answer, slug: answerSlug, cookies: jar };
}

// --- Discover (no UI) -------------------------------------------------------

function storyFrom(item) {
  if (!item || typeof item !== 'object') return null;
  const preview = Array.isArray(item.web_results_preview && item.web_results_preview.first_urls)
    ? item.web_results_preview.first_urls[0]
    : null;
  return {
    title: item.title || item.short_title || '(untitled)',
    summary: item.summary || item.description || null,
    url: item.url || (item.slug ? `${ORIGIN}/discover/${item.slug}` : preview),
    source: item.domain_name || null,
    published: item.published_timestamp || item.updated_datetime || null,
    item_type: item.item_type || null,
  };
}

async function discoverFeed({ limit = 20, offset = 0, cookies } = {}) {
  const jar = cookies || await getCookies();
  const safeLimit = toInt(limit, 20);
  const safeOffset = toInt(offset, 0);
  const res = await internalFetch(
    `/rest/discover/feed?limit=${safeLimit}&offset=${safeOffset}&version=${API_VERSION}&source=default`, jar);
  const body = assertBody(res, 'discover feed',
    (b) => b && typeof b === 'object' && Array.isArray(b.items),
    'expected an items array');
  return { cookies: jar, items: body.items.map(storyFrom).filter(Boolean), nextToken: body.next_token || null };
}

async function discoverTopics({ cookies } = {}) {
  const jar = cookies || await getCookies();
  const res = await internalFetch(`/rest/discover/topics?version=${API_VERSION}&source=default`, jar);
  const body = assertBody(res, 'discover topics',
    (b) => b && typeof b === 'object' && Array.isArray(b.all_topics),
    'expected an all_topics array');
  const selected = Array.isArray(body.user_selected_topics) ? body.user_selected_topics : [];
  // Elements can be null: the server has done it for topics, and an unguarded
  // property read would surface as an opaque TypeError instead of a topic list.
  const label = (t) => (t && typeof t === 'object' ? (t.topic || t.title || t.key || null) : t) ?? '(unnamed)';
  return {
    cookies: jar,
    selected: selected.map(label),
    all: body.all_topics.map(label),
  };
}

// --- Models (no UI) ---------------------------------------------------------

async function listModels({ cookies } = {}) {
  const jar = cookies || await getCookies();
  const res = await internalFetch(`/rest/models/config/v2?version=${API_VERSION}&source=default`, jar);
  const body = assertBody(res, 'model config',
    // A non-null but wrong-typed `models` (string/number) passed the old guard
    // and then produced char-by-char `Object.entries` garbage or an empty list
    // that looked like a successful response. Accept only a list or a map.
    (b) => b && typeof b === 'object'
      && (Array.isArray(b.models) || (b.models !== null && typeof b.models === 'object')),
    'expected a models payload');
  const models = body.models;
  const entries = Array.isArray(models)
    // Spread first: a trailing `...m` would clobber the computed fallback, and
    // the server sometimes sends `id: null` next to a usable `model` field.
    ? models.map((m, i) => ({ ...m, id: (m && (m.id || m.model)) || String(i) }))
    : Object.entries(models).map(([id, m]) => ({ ...m, id }));
  return {
    cookies: jar,
    models: entries.map((m) => ({
      id: m.id,
      label: m.label || m.short_name || m.id,
      description: m.description || null,
      mode: m.mode || null,
      provider: m.provider || null,
    })),
    defaults: body.default_models || null,
  };
}

module.exports = {
  listThreads,
  searchHistory,
  getThread,
  latestAnswer,
  submitAsk,
  parseAskStream,
  discoverFeed,
  discoverTopics,
  listModels,
};
