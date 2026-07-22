# Resume Project Entry

Copy the block below directly into your resume/portfolio. A short "talking points" section follows for interviews or a LinkedIn write-up — that part isn't meant to go on the resume itself.

---

## Swiggy MCP Personal Dashboard — AI Shopping Agent
**Node.js · Express 5 · React/Vite · SQLite · Model Context Protocol (MCP) · Groq (LLM + Vision) · OAuth 2.1/PKCE**

A full-stack agentic ordering assistant built on Swiggy's official Model Context Protocol (MCP) servers — turns free-text and photo input into real food and grocery orders on Swiggy Food and Instamart.

- **Architected an AI agent on Swiggy's MCP servers**, integrating Food and Instamart endpoints via OAuth 2.1 + PKCE with Dynamic Client Registration (RFC 7591) — one of the earliest consumer builds on Swiggy's agent-commerce API, with no prior reference implementation to follow.
- **Diagnosed and eliminated a critical latency bottleneck**: profiled the initial "every message to the LLM" design at 7 Groq completions / 129s for one guided cart-add, then redesigned the agent around a deterministic-first architecture (brand selection, quantity/size matching, relevance ranking, and cart merging all resolved in code, not model calls) — cutting typical interactions to 0–2 LLM completions and sub-2-second responses.
- **Built a one-completion recipe-to-cart pipeline**: "order what I need for biryani" triggers a single LLM call to propose ingredients, then a fully deterministic pipeline searches, ranks, size-matches, and adds the best in-stock option per ingredient in parallel — verifying every add against the actual returned cart rather than trusting a non-error response, after discovering Swiggy's API can silently drop items with no error at all.
- **Shipped a computer-vision import feature** (Groq's Llama-4 Scout vision model) that reads a screenshot of a cart from any competing quick-commerce app and reproduces it on Instamart, exact-matching by product, brand, and pack size with ranked fallback alternatives for anything unavailable.
- **Reverse-engineered and hardened against an undocumented live API**: found and worked around multiple discrepancies between Swiggy's published MCP docs and actual server behavior (non-functional unscoped search, silent cart-drop failures, stale MCP connections, price-sort masking correct results) by building a verify-against-the-live-server discipline into every feature rather than trusting documentation.
- **Delivered production-grade reliability and security practices**: idempotent retry logic with automatic reconnect on transport failure, OAuth token lifecycle handling, a background scheduler with fail-safe guarantees (adds only, never auto-checkout), and loopback-only network binding after identifying and closing an unintended LAN exposure.

---

## Talking points / deeper narrative (interviews, LinkedIn, portfolio page — not for the resume itself)

**The core engineering story is a measured performance turnaround.** The first version of the grocery chat agent was a standard "hand every message to the LLM and let it call tools" loop. Instrumenting it (wall-clock time, request size, token usage per completion) showed a single guided "add milk → pick brand → add item" flow costing 7 Groq completions and 129 seconds — not because any one call was doing heavy work, but because most of what the loop was "deciding" (how many brands came back, which one to filter to, whether to ask a question or show results) was actually a deterministic function of the data already in hand. Replacing model judgment with plain code wherever the decision didn't need real reasoning — while keeping the LLM for the genuinely hard parts (interpreting free text, proposing a recipe's ingredient list, reading a screenshot) — is the throughline across the whole project.

**Two features show the same pattern at different scales:**
- *Recipe ordering*: one LLM call proposes ingredients for a dish; a deterministic pipeline (parallel search, relevance filtering, quantity/size parsing normalized across units, stock/price ranking, real-cart-verified batch add) fills the cart. Zero further model calls after the first.
- *Screenshot import*: one vision call reads line items off a competitor app's cart screenshot; the same deterministic matching pipeline finds exact or closest in-stock equivalents on Instamart. The vision step is isolated to exactly the one place in the app that genuinely needs to "see."

**A recurring theme was verifying reality over trusting documentation.** Swiggy's MCP docs describe intended behavior; the live beta server didn't always match it — an unscoped dish-search tool that the docs describe as working across restaurants returns zero results every time; a "fetch coupons" tool always returns an empty object; and most notably, `update_cart` can report success while silently failing to add a specific item, with no error at all. Each of these was found by inspecting real API responses rather than assuming the docs were accurate, and each shaped a concrete design decision (e.g., every cart mutation now re-reads the actual cart afterward and reports counts from what's really there, never from whether the call threw).

**Production-quality practices, at personal scale.** Even as a single-user local tool, the system follows practices that matter at any scale: idempotent retries paired with automatic reconnection when a cached connection goes stale, OAuth token expiry handled as "re-authenticate," a background scheduler that can only ever add to a cart (never place an order, by design), and a network-exposure bug (the backend defaulting to listen on all interfaces instead of loopback) that was caught and fixed before it became a real vulnerability.
