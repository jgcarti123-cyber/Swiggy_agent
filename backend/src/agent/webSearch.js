import { config } from "../config.js";

const TAVILY_URL = "https://api.tavily.com/search";

// Thin wrapper around Tavily's /search API — verified against their live
// docs before writing this (POST, Authorization: Bearer <key>, body
// {query, search_depth, max_results, include_answer}, response
// {answer, results: [{title, url, content, ...}]}).
//
// This is an ENHANCEMENT, never a hard dependency: every caller must treat a
// null return (no key configured, network failure, non-2xx response) as
// "no grounding available" and fall back to the model's own knowledge — the
// same fail-open posture every other optional LLM-helper in this app already
// uses (see e.g. discoveryAgent.js). Never throw out of here.
//
// `country` is Tavily's own result-boosting param (confirmed in their live
// API reference: "Boost search results from a specific country... available
// only if topic is general" — this app never sets `topic`, so it's always
// the default "general"). This app is built specifically for an Indian
// Instamart catalogue, so the recipe-grounding caller passes `country:
// "india"` to bias results toward Indian recipe sources rather than
// whatever a bare dish name happens to rank globally.
export async function searchWeb({ query, maxResults = 4, country }) {
  if (!config.tavilyApiKey) return null;
  try {
    const res = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.tavilyApiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: maxResults,
        include_answer: "basic",
        ...(country ? { country } : {}),
      }),
    });
    if (!res.ok) {
      console.error(`[webSearch] Tavily returned ${res.status} for query "${query}"`);
      return null;
    }
    const data = await res.json();
    const results = (Array.isArray(data.results) ? data.results : [])
      .map((r) => ({
        title: typeof r.title === "string" ? r.title : null,
        url: typeof r.url === "string" ? r.url : null,
        content: typeof r.content === "string" ? r.content : null,
      }))
      .filter((r) => r.content);
    return { answer: typeof data.answer === "string" ? data.answer : null, results };
  } catch (err) {
    console.error(`[webSearch] Tavily request failed for query "${query}": ${err.message}`);
    return null;
  }
}
