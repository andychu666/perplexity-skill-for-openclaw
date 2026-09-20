'use strict';
// Shared Perplexity session layer — public surface.
//
// The implementation is split by concern: session-core.js holds the CDP/HTTP
// plumbing, session-api.js holds the endpoint verbs. CommonJS so both
// perplexity-query.js (CJS) and the .mjs helpers can require this unchanged.
//
// Cookies are never printed and never written to disk.

const core = require('./session-core.js');
const api = require('./session-api.js');

module.exports = {
  CDP_URL: core.CDP_URL,
  ORIGIN: core.ORIGIN,
  getCookies: core.getCookies,
  csrfToken: core.csrfToken,
  internalFetch: core.internalFetch,
  threadSlug: core.threadSlug,
  entryAnswer: core.entryAnswer,
  listThreads: api.listThreads,
  searchHistory: api.searchHistory,
  getThread: api.getThread,
  latestAnswer: api.latestAnswer,
  submitAsk: api.submitAsk,
  parseAskStream: api.parseAskStream,
  discoverFeed: api.discoverFeed,
  discoverTopics: api.discoverTopics,
  listModels: api.listModels,
};
