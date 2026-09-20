#!/usr/bin/env node
// Perplexity Search API fallback for the perplexity-pro skill.
// Usage: search-api.mjs <query> [query2 ...] [--json] [--timeout <seconds>]

const args = process.argv.slice(2);

const queries = [];
let jsonOutput = false;
let timeoutSeconds = 60;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json") {
    jsonOutput = true;
  } else if (arg === "--timeout") {
    const next = Number(args[++i]);
    if (!Number.isFinite(next) || next <= 0) {
      console.error("Error: --timeout needs a positive number of seconds");
      process.exit(2);
    }
    timeoutSeconds = next;
  } else if (arg.startsWith("-")) {
    console.error(`Error: unknown option ${arg}`);
    process.exit(2);
  } else {
    queries.push(arg);
  }
}

if (queries.length === 0) {
  console.error("Usage: search-api.mjs <query> [query2 ...] [--json] [--timeout <seconds>]");
  console.error("Example: search-api.mjs 'What is Perplexity?' 'Latest AI news'");
  process.exit(1);
}

// Drop blank/whitespace-only queries: they would burn quota and usually 422.
const cleanQueries = queries.map((q) => q.trim()).filter((q) => q.length > 0);
if (cleanQueries.length === 0) {
  console.error("Error: no non-empty query given");
  process.exit(2);
}

const apiKey = process.env.PERPLEXITY_API_KEY;
if (!apiKey) {
  console.error("Error: PERPLEXITY_API_KEY environment variable not set");
  process.exit(1);
}

const MAX_RESULTS = 5;
const SNIPPET_CHARS = 300;

const SEARCH_API_URL = "https://api.perplexity.ai/search";

async function searchOne(query) {
  // Without a timeout a stalled connection hangs the CLI forever with no output.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(SEARCH_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      // The Search API takes a single query string; an array fails validation.
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Truncate: an HTML error page would otherwise dump kilobytes to stderr.
      const error = (await response.text()).slice(0, 300);
      throw new Error(`Perplexity API error (${response.status}): ${error}`);
    }

    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`request timed out after ${timeoutSeconds}s (raise --timeout)`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function itemsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.results)) return result.results;
  if (result && typeof result === "object") {
    return Object.values(result).filter(
      (v) => v && typeof v === "object" && (v.title || v.url || v.snippet)
    );
  }
  return [];
}

function formatItems(items, query) {
  const lines = [];
  if (query) {
    // Single line only: a newline (or "##") in a query would break the header.
    lines.push(`## ${String(query).replace(/\s+/g, ' ').slice(0, 120)}\n`);
  }
  if (!items || items.length === 0) {
    lines.push("_No results._\n");
    return lines.join("\n");
  }
  for (const item of items.slice(0, MAX_RESULTS)) {
    if (item.title) lines.push(`**${item.title}**`);
    if (item.url) lines.push(item.url);
    // Type guard: a non-string snippet would throw on .split().
    if (typeof item.snippet === "string" && item.snippet) {
      const firstLine = item.snippet.split("\n")[0];
      const clean = firstLine.slice(0, SNIPPET_CHARS);
      lines.push(clean + (firstLine.length > SNIPPET_CHARS ? "..." : ""));
    }
    lines.push("");
  }
  return lines.join("\n");
}

try {
  // One request per query: each result keeps its own label, and a batch never
  // gets attributed to queries[0]. Requests run concurrently (offsets are
  // independent) and one failure must not discard the queries that worked.
  const settled = await Promise.allSettled(cleanQueries.map((q) => searchOne(q)));
  const collected = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      collected.push({ query: cleanQueries[i], result: outcome.value });
    } else {
      console.error(`Error: query "${cleanQueries[i]}" failed: ${outcome.reason.message}`);
    }
  });
  if (collected.length === 0) process.exit(1);

  if (jsonOutput) {
    const payload =
      collected.length === 1
        ? collected[0].result
        : collected.map(({ query, result }) => ({ query, results: itemsOf(result) }));
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const { query, result } of collected) {
      console.log(formatItems(itemsOf(result), collected.length > 1 ? query : null));
    }
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
