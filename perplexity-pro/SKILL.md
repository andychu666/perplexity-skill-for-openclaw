---
name: perplexity-pro
description: >
  Query Perplexity Pro for grounded AI answers with citations via Chrome CDP automation on the OpenClaw-managed browser.
  Use when (1) deep research with web citations needed, (2) questions where web_search
  is insufficient, (3) image generation requests, (4) complex multi-step research queries,
  (5) analyzing a specific URL, (6) continuing a conversation thread, (7) computer/tool-use tasks.
  (8) browsing the Discover news feed by category, (9) searching your own past
  threads (Library history) for prior research on a topic.
  Flags: --brief, --detailed, --chat, --url, --deep, --computer, --discover, --history.
  Uses the OpenClaw-managed Chrome browser (CDP on :18800).
---

# Perplexity Pro (OpenClaw)

Query Perplexity Pro via Chrome CDP browser automation using the OpenClaw-managed Chrome instance (CDP on :18800).

## Scope & verification status

**Verified end to end with OpenClaw only.** The scripts are plain Node + `puppeteer-core`,
but no other harness has been exercised against this skill, so no other harness is claimed.

## Prerequisites

- The OpenClaw-managed Chrome running with CDP on `:18800` (`PERPLEXITY_CDP` overrides)
- Logged into Perplexity Pro account in Chrome (see [Login](#login-do-this-once-before-your-first-query))
- `puppeteer-core` available

## Setup

Run once before first use:

```bash
cd {baseDir} && npm install
```

If a `puppeteer-core` install already exists on this host, the scripts reuse it (auto-detected).
skill installed, the script will reuse its `puppeteer-core` automatically and you can skip `npm install`.

## Tests

Pure CLI/arg-parsing logic is covered by zero-dependency unit tests (Node's
built-in `node:test`). No browser required:

```bash
cd {baseDir} && npm test
```

## Quick Start

The skill drives the **OpenClaw-managed Chrome** over CDP at `http://127.0.0.1:18800`
— the browser OpenClaw itself manages. Do not hand-launch a second Chrome for this
skill: one profile means one login, shared by the UI path and the session/API path.

```bash
# Confirm the managed browser is up
curl -s http://127.0.0.1:18800/json/version
```

To use a different browser, point the skill at it instead of editing the code:

```bash
export PERPLEXITY_CDP=http://127.0.0.1:<port>
```

## Login (do this once, before your first query)

Perplexity Pro answers require a signed-in session. The login lives in the browser
**profile on disk** (`~/.openclaw/browser/openclaw/user-data`), not in the running
process, so you sign in once and later runs reuse it.

1. Sign in to Perplexity in the **OpenClaw-managed browser** (open it from the
   Control UI or with the `browser` tool; use a non-headless session if you need a
   visible window to complete the login).
2. Verify the session the skill will actually see:

```bash
node scripts/perplexity-session.mjs --whoami
```

A usable session prints `session: OK ... csrf: present`. **Cookies alone are not
enough**: without `next-auth.csrf-token` (`csrf: missing`) the internal endpoints
reject the call — sign in again in *that* profile, or point `PERPLEXITY_CDP` at the
profile that has it.

## Quick Query

```bash
node {baseDir}/scripts/perplexity-query.js "your question here"
```

## Flags

| Flag | Description | Combinable with |
|------|-------------|-----------------|
| `--brief` | Append "Answer briefly in 2-3 sentences" | `--chat`, `--deep`, `--url` |
| `--detailed` | Append "Provide a detailed, comprehensive answer" | `--chat`, `--deep`, `--computer`, `--url` |
| `--chat` | Continue in existing Perplexity thread (requires active `/search/` or `/thread/` tab) | `--brief`, `--detailed`, `--url` |
| `--url <URL>` | Prepend a URL for Perplexity to analyze (must be http/https) | All except conflicts |
| `--deep` | Enable Deep Research mode (extended timeout: 10 min) | `--brief`, `--detailed`, `--chat`, `--url` |
| `--computer` | Use Computer mode at `/computer/new` (extended timeout: 30 min) | `--detailed`, `--url` |
| `--discover [category]` | List Discover news headlines for a category (no query needed) | `--limit` |
| `--history "<term>"` | Search YOUR thread history (Library) for matching past threads | `--limit` |
| `--library "<term>"` | Alias for `--history` | `--limit` |
| `--limit N` | Max results for `--discover` / `--history` (default: 10) | `--discover`, `--history` |

### Discover Categories

`--discover` accepts: `top` (default), `tech`, `finance`, `arts`, `sports`, `entertainment`,
`for-you` (alias: `you`), or `all` (scrape every category). No login query is sent; it just
scrapes the Discover feed cards (title, url, published time, source count).

### Flag Conflicts (mutually exclusive)

- `--brief` + `--detailed` — contradictory instructions
- `--deep` + `--computer` — different Perplexity modes
- `--chat` + `--computer` — chat requires existing thread, computer starts fresh
- `--brief` + `--computer` — computer mode produces long-form output

## Examples

```bash
SKILL_DIR={baseDir}

# Standard query
node $SKILL_DIR/scripts/perplexity-query.js "What is quantum computing?"

# Brief answer
node $SKILL_DIR/scripts/perplexity-query.js --brief "Explain Docker containers"

# Detailed research
node $SKILL_DIR/scripts/perplexity-query.js --detailed "Compare React vs Vue in 2026"

# Analyze a URL
node $SKILL_DIR/scripts/perplexity-query.js --url https://example.com/article "Summarize this article"

# Deep Research (10 min timeout)
node $SKILL_DIR/scripts/perplexity-query.js --deep "History of semiconductor manufacturing"

# Computer mode (30 min timeout)
node $SKILL_DIR/scripts/perplexity-query.js --computer "Create a comparison table of top 5 cloud providers"

# Continue conversation in existing thread
node $SKILL_DIR/scripts/perplexity-query.js --chat "What about the security implications?"

# Deep Research with URL
node $SKILL_DIR/scripts/perplexity-query.js --deep --url https://arxiv.org/abs/1234.5678 "Analyze this paper"

# Discover: today's top headlines
node $SKILL_DIR/scripts/perplexity-query.js --discover top

# Discover: tech headlines, top 5
node $SKILL_DIR/scripts/perplexity-query.js --discover tech --limit 5

# Discover: your personalized feed
node $SKILL_DIR/scripts/perplexity-query.js --discover you

# Discover: every category at once
node $SKILL_DIR/scripts/perplexity-query.js --discover all --limit 10

# History: search your OWN past threads (Library) for prior research
node $SKILL_DIR/scripts/perplexity-query.js --history "whisper"

# History: alias + cap the number of results
node $SKILL_DIR/scripts/perplexity-query.js --library "dashcam transcription" --limit 5
```

## Discover Output JSON

```json
{
  "mode": "discover",
  "generatedAt": "2026-06-03T...",
  "categories": {
    "tech": [
      { "title": "...", "url": "https://www.perplexity.ai/discover/tech/...", "sources": 14, "published": "8 hours ago" }
    ]
  }
}
```

## History Output JSON

```json
{
  "mode": "history",
  "query": "whisper",
  "count": 6,
  "threads": [
    { "type": "Search", "title": "ffmpeg filters to reduce Whisper hallucination on dashcam audio", "age": "2mo ago", "url": null }
  ],
  "screenshot": "/tmp/perplexity-history-1710000000000.png",
  "url": "https://www.perplexity.ai/library?q=whisper"
}
```

Notes:
- The Library search is **semantic/fuzzy** — a returned thread may not contain the
  literal search term (e.g. searching `ollama` also surfaces general local-LLM threads).
- `type` is the thread kind (`Search`, `Deep research`, `Computer`, …); `age` is the
  relative timestamp Perplexity shows.
- `url` is usually `null`: Library rows navigate via the in-app router, not `<a>`
  links, so a per-thread URL can't be scraped reliably. Use the title to locate the
  thread, or open `url` (the filtered Library view) in a browser.

## Output JSON

```json
{
  "query": "...",
  "answer": "...",
  "mode": "standard|brief|detailed|chat|deep|computer",
  "isImageGeneration": false,
  "generatedImages": [{"path": "/tmp/perplexity-gen-1710000000000-0.png", "alt": "...", "width": 2848, "height": 1600}],
  "images": [],
  "sources": [{"title": "...", "url": "..."}],
  "screenshot": "/tmp/perplexity-result-1710000000000.png",
  "url": "https://www.perplexity.ai/search/..."
}
```

For image generation queries, `isImageGeneration` is `true` and images are auto-downloaded to `generatedImages[].path`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PERPLEXITY_TIMEOUT` | `120000` | Max wait for standard answer (ms) |
| `PERPLEXITY_DEEP_TIMEOUT` | `600000` | Max wait for Deep Research (ms) |
| `PERPLEXITY_COMPUTER_TIMEOUT` | `1800000` | Max wait for Computer mode (ms) |
| `PERPLEXITY_OUTPUT_DIR` | `/tmp` | Screenshot/image output directory |
| `PERPLEXITY_RETRIES` | `2` | Max retry attempts with exponential backoff |

## Differences from the OpenClaw Original


- Uses `puppeteer-core` instead of `playwright-core` (resolved from this skill's `node_modules`, or reused from the browser-tools skill)
- Connects to the OpenClaw-managed Chrome at `http://127.0.0.1:18800` (`PERPLEXITY_CDP` overrides)
- One browser profile for both paths: the UI automation and the session/API layer share the OpenClaw-managed login
- Headless-friendly: Chrome started with `--headless` works (log into Perplexity at least once interactively first)
- Deep Research toggle rewritten for Perplexity's current Radix dropdown UI

## Prompting guide

**The query string is a research question, not a command.** Whatever you pass
becomes what Perplexity researches on the web, so be specific, state constraints,
and name the deliverable you want back:

- Good: `"Compare Postgres vs MySQL for write-heavy time-series workloads in 2026 — cover partitioning, compression, and ingestion throughput; give a table with tradeoffs"`
- Weak: `"postgres vs mysql"`

- Put the *output shape* in the prompt ("give a table", "list with tradeoffs", "cite sources for each claim").
- `--brief` for a single fact; `--detailed` / `--deep` when you want multi-source synthesis with citations.
- `--url <page>` grounds the answer in a specific source instead of the open web.
- Consume the JSON `answer` + `sources` fields programmatically — don't rely on the screenshot.

### Asking about Perplexity's *own* UI (Discover, library, threads) — scrape it, don't query it

Perplexity **cannot see its own Discover feed**. A text query like *"what's on
Perplexity Discover today?"* returns a generic web answer, not the real cards. To
get the actual feed you must read the **DOM** — use `--discover` (which does exactly
that), or drive the browser directly. Canonical agent prompt for a news digest:

> Use the browser tools to open https://www.perplexity.ai/discover, click the Top
> tab, and scrape the real story cards (headline + URL from the DOM — don't ask
> Perplexity as a text query, it can't see its own feed). Then write
> ~/Downloads/discover-news.md with each story as: ## Headline, a one-line summary,
> and a clickable link to its Perplexity URL.

The same rule applies to anything that is *UI state* rather than a researchable
question (your library, saved threads, account settings): **scrape the DOM, don't
ask Perplexity about itself.**

## Usage Guidelines

- Start with `web_search` for quick facts — escalate to Perplexity for depth
- Perplexity is best for: multi-source synthesis, current events, citation-heavy answers
- Use `--brief` for quick factual lookups, `--detailed` for research
- Use `--deep` for complex topics requiring extensive research
- Use `--computer` for tasks that need Perplexity's tool-use capabilities
- Use `--chat` to follow up on a previous query in the same thread
- Use `--url` to ask Perplexity to analyze a specific webpage

## Session reuse (no UI driving)

The OpenClaw Chrome profile already holds a signed-in Perplexity Pro session.
`scripts/perplexity-session.mjs` reads its cookies over CDP (including the
httpOnly session cookies) and pairs the CSRF cookie with an `x-csrf-token`
header, so internal endpoints can be called without clicking through the UI:

```bash
node scripts/perplexity-session.mjs --whoami
node scripts/perplexity-session.mjs --thread https://www.perplexity.ai/search/<slug>
node scripts/perplexity-session.mjs --json --thread <slug>
```

Cookies are never printed and never written to disk. This is the least brittle
layer (no menu selectors, no composer typing, no stream waiting).

```bash
node scripts/perplexity-session.mjs --whoami
node scripts/perplexity-session.mjs --thread <url|slug>
node scripts/perplexity-session.mjs --history "<term>" [--limit N]
node scripts/perplexity-session.mjs --discover [--limit N]
node scripts/perplexity-session.mjs --models
node scripts/perplexity-session.mjs --ask "<question>" [--thread <url>] [--model <id>]
```

- `--ask` submits through the session layer, so a follow-up needs no composer at
  all; `--model` picks any id from `--models` (model switching without the UI)
- `--discover` reads the Discover feed, `--models` lists the account's models
- `--history` scans the thread list in 200-item pages (the endpoint ignores a
  search field and the GraphQL API only serves allow-listed operations, so there
  is no server-side thread search to call)

Fall back to the UI path only for actions that exist nowhere else (Computer mode,
interactive Discover browsing).

## Deep research via the Agent API (preferred when a key is set)

`--deep` through the browser is fragile (the mode lives in the composer's `/`
menu and must be picked on an empty composer). When `PERPLEXITY_API_KEY` is
available, prefer the Agent API instead:

```bash
node scripts/perplexity-research.mjs --query "..." --preset medium
node scripts/perplexity-research.mjs --resume <job_id>     # collect a background job
```

- presets: `fast` (seconds) · `low` · `medium` (default) · `high` · `xhigh`
- `high`/`xhigh` run as background jobs, polled with backoff; if the run times out
  the server-side job continues and `--resume <job_id>` collects it
- **save-and-preview**: the full report goes to `<output-dir>/*.md` + `*.json`;
  stdout carries only a preview (`--stdout-preview`, default 1500 chars) and the
  saved paths, so a long report does not flood the agent's context
- the run prints the API cost it incurred; keep `high`/`xhigh` for real research

## API fallback (search-api.mjs)

When the browser is unavailable, `scripts/search-api.mjs` queries the official
Perplexity Search API instead:

```bash
export PERPLEXITY_API_KEY=pplx-...
node scripts/search-api.mjs "your question" --json
node scripts/search-api.mjs "q1" "q2" --timeout 90
```

Each query is sent as its own request (the API expects a single `query` string),
so batch results keep their per-query label. Requires `PERPLEXITY_API_KEY`;
without a key the script exits with a clear error rather than an empty result.

## Troubleshooting

- **"Could not connect to browser"**: Make sure Chrome is running on `:18800`. Check with `curl -s http://127.0.0.1:18800/json/version`.
- **"Could not find search input"**: Perplexity UI may have changed; check debug screenshot at `/tmp/perplexity-debug-*.png`.
- **Timeout with no answer**: Answer rendered but extraction failed; check result screenshot.
- **Not logged in**: You must log into Perplexity at least once. If running headless, start Chrome without `--headless` first, log in, then restart with `--headless` (the profile persists).
- **"--chat requires existing thread"**: Navigate to a Perplexity search page first, then use `--chat`.
- **Deep Research**: The mode selector is a Radix dropdown button (`aria-haspopup="menu"`) next to the search box. It only opens on a real pointer click, so the script uses a Puppeteer element-handle click, then selects the "Deep research" `menuitemradio`. The script verifies the mode actually switched and logs `Deep Research mode enabled` on success. If Perplexity changes the menu label/locale, update the text lists in `toggleDeepResearch()`.
