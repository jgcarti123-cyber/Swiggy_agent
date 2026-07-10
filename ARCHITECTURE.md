# Architecture

This is a personal, single-user, local-only dashboard with two features:

1. **Feast Finder** — type a dish, see nearby open restaurants ranked by rating, filtered by a veg/non-veg/all toggle, with up to 6 matching menu items per restaurant (photos, LLM-estimated nutrition), a "surprise me" dish randomiser, and an on-demand real coupon price per item. When a search finds nothing, broader "try instead" suggestions are offered instead of a dead end.
2. **Pantry Pal** — a chat box that turns free-text ("add milk") into real Instamart cart actions. Broad requests get a guided brand → variant picker with photos and a cart quantity stepper. Most of this guided flow and every cart mutation is **deterministic backend code, not the model deciding** — this is the single biggest architectural fact about this feature and is covered in depth in §6.

Both features are built on Swiggy's official MCP (Model Context Protocol) servers, which expose Swiggy's food-ordering and grocery-ordering capabilities as a set of callable tools rather than a REST API. Everything runs on `localhost`. There is no multi-user support, no production deployment — this document assumes you're reading it to understand *why* the code is shaped the way it is, not just what it does.

This file has grown alongside the code across many sessions. Where a design was tried, measured, and replaced by something else, that's stated explicitly — several sections here describe the *second* (or third) version of something, not the first idea.

---

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Backend | Node.js + Express 5 | Only the backend talks to Swiggy MCP and holds the OAuth token — the frontend never sees Swiggy directly |
| Frontend | React + Vite | Minimal SPA, a sidebar switching between two panels, no routing framework needed |
| Storage | SQLite (`better-sqlite3`) | Single-user, single-file, holds the OAuth token, saved address, and order log |
| MCP client | `@modelcontextprotocol/sdk` (official TS SDK) | Speaks the actual MCP Streamable HTTP protocol to `mcp.swiggy.com` |
| LLM | Groq (`groq-sdk`), model `openai/gpt-oss-120b` | Powers restaurant-discovery judgment calls and free-text interpretation in the Instamart chat — see §5 for why Groq specifically, and its consequences |

Originally the Instamart chat was built on Anthropic's SDK using its native "MCP connector" beta feature (where Anthropic's own infrastructure calls the remote MCP server for you, server-side, and hands back a transcript). That was replaced with Groq + a hand-rolled tool-calling loop when the project switched to Groq for cost reasons — Groq has no equivalent server-side MCP execution, so the backend now executes every tool call itself (§6.1). That loop, in turn, was later found to be far too slow and expensive to run for *every* interaction, which is the story in §6.3 — most of what the loop used to decide is now decided in plain code instead.

---

## 2. The MCP layer — how Swiggy's tools are actually called

This is the foundation everything else sits on, so it's worth understanding before the features.

### 2.1 What Swiggy's MCP servers are

Swiggy exposes two independent MCP servers:

- **Food** — `https://mcp.swiggy.com/food` — search restaurants/menus, manage a food cart, place orders.
- **Instamart** — `https://mcp.swiggy.com/im` — search grocery products, manage a grocery cart, checkout.

They are completely independent: no shared cart, no shared session. Each is a **Streamable HTTP MCP server** — meaning a client connects over HTTP(S), does an MCP protocol handshake, and then calls named tools (`search_menu`, `get_cart`, etc.) with JSON arguments, getting back JSON (or text) results. This is fundamentally different from a REST API: there's no OpenAPI spec to read against, no fixed URL-per-resource — the *tool definitions themselves* (name, description, JSON-schema parameters) are the contract, and they're discovered/used exactly like an LLM would use them, except in most of this codebase our own code is the "caller," not a model (see §6 for where that's still true and where it isn't anymore).

### 2.2 `backend/src/mcp/mcpClient.js` — the generic transport

This is the one place that actually opens a connection to a Swiggy MCP server:

```js
const client = new Client({ name: "swiggy-personal-dashboard", version: "0.1.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
await client.connect(transport);
```

Key design points:

- **One cached, connected client per server URL** (`cache: Map<serverUrl, {client, token}>`). Opening an MCP connection involves a protocol handshake, so it's kept alive and reused across requests rather than reconnected every time.
- **Reconnects transparently when the token changes** — the cache key includes the token used to build that connection, so a fresh login (new token) causes a fresh connection on the next call.
- **`callSwiggyTool(serverUrl, name, args)`** is the single chokepoint every tool call goes through. It calls `client.callTool({ name, arguments })`, then unwraps the MCP response shape:
  - If `result.isError`, it throws a `SwiggyToolError` carrying the tool's own error message.
  - If `result.structuredContent` exists, that's returned directly.
  - Otherwise it takes the text content block(s) and tries `JSON.parse` (Swiggy's tools mostly return JSON-as-text), falling back to raw text if parsing fails.
- **The cached connection is dropped on two kinds of failure, not just one.** Originally only a 401 (token revoked/expired server-side) invalidated the cache. A later live incident found a second cause: the cached connection itself can silently go bad independent of the token — a long-running backend process had every Instamart call fail with a raw `"fetch failed"` network error, while a brand-new connection to the *identical* server succeeded instantly. So `callSwiggyTool` now also drops the cache on network-level error patterns (`fetch failed`, `ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `socket hang up`, `ETIMEDOUT`) — not just auth errors — so the next call (including an automatic retry, see §6.6) reconnects from scratch instead of repeating the same dead connection's failure forever.

### 2.3 `foodClient.js` / `instamartClient.js` — typed wrappers

These are thin, typed wrappers around `callSwiggyTool`, one function per Swiggy tool. Every parameter name was taken directly from the live tool schemas / live responses (fetched from the actual connected MCP servers during development), not guessed or inferred from documentation — Swiggy's own docs describe tool *behavior* narratively but the parameter names/types, and in several cases the actual response *shape*, come from the tools themselves.

**Food tools actually called:** `get_addresses`, `search_restaurants`, `search_menu` (scoped, per-restaurant), `get_restaurant_menu` *(wrapped but unused in the current flow)*, `apply_food_coupon`, `update_food_cart`, `get_food_cart`, `place_food_order`, `track_food_order`, `flush_food_cart`. `fetch_food_coupons` is wrapped but never called for real pricing anymore — see §4.3.

**Instamart tools actually called:** `get_addresses` *(UI address-picker only — never by the chat agent, see §6.2)*, `search_products`, `update_cart`, `get_cart`, `clear_cart`, `your_go_to_items`, `get_payment_options`, `checkout`. `get_orders` and `track_order` are wrapped but were deliberately dropped from the chat agent's tool list (§6.2) to shrink the per-request payload — they were never central to the "fill my cart" use case.

`instamartClient.js` additionally wraps `update_cart` and `clear_cart` in an idempotent-safe automatic retry — see §6.6.

### 2.4 A crucial, hard-won fact: `search_menu`'s real behavior

`search_menu` has two modes, and this shaped the entire Feast Finder design:

- **Scoped** (`restaurantIdOfAddedItem` set): searches one restaurant's menu for a dish. Works reliably.
- **Unscoped** (`restaurantIdOfAddedItem` omitted): per Swiggy's own tool description, this should search *across* restaurants near an address — i.e. exactly "find restaurants serving dish X." **Verified live, repeatedly, across many dishes and addresses: it always returns zero results.** This is the mechanism the original project design (`CLAUDE.md`) was built around, and it simply doesn't work in the current Swiggy MCP beta.

Because of this, Feast Finder cannot do "one search call, get restaurants back." Instead it does `search_restaurants` (a restaurant **name/cuisine-tag** text match, which works, but is not a dish search) to get candidates, then *scoped* `search_menu` per candidate restaurant. This is the origin of the whole agent-based discovery pipeline in §4 — including a second-order problem it creates (§4.5): `search_restaurants` finds nothing for a dish whose name doesn't literally appear in any nearby restaurant's name or cuisine tags, even when a real match exists two streets over under a different label.

A second, related discovery: scoped `search_menu` **also doesn't return empty when a restaurant has no real match** — it falls back to returning loosely-related items from that restaurant's menu instead of an empty list (verified: querying "butter chicken" at a biryani specialist returned 10 items, none of them butter chicken). This is why there's an LLM relevance-judgment step, not just a raw pass-through of whatever `search_menu` returns (§4.4).

### 2.5 Instamart's `search_products` — what the live response actually contains

Confirmed by inspecting the raw response (the docs only describe the generic `{success, data, message}` envelope, not field names):

```jsonc
{
  "nextOffset": ...,
  "products": [{
    "displayName": "Amul Taaza Milky Milk",
    "brand": "Amul",
    "inStock": true, "isAvail": true,
    "productId": "...", "parentProductId": "...", "isPromoted": false,
    "variations": [{
      "spinId": "SKS75T1GV1", "skuId": "FJWQV94M43",
      "quantityDescription": "500 ml",
      "displayName": "Amul Taaza Milky Milk", "brandName": "Amul",
      "price": { "mrp": 30, "offerPrice": 26 },
      "isInStockAndAvailable": true,
      "imageUrl": "https://media-assets.swiggy.com/..."
    }]
  }]
}
```

Two things this shape enables and one trap it sets, both load-bearing for §6:

- **`brand` is a real field** — brand-grouping for the guided picker (§6.4) is a deterministic group-by, not an LLM guess.
- **`imageUrl` and price are per-variant**, not per-product — the image side-channel (§6.7) caches at the variant (`spinId`) level.
- **The trap**: Swiggy freely mixes out-of-stock variants (`isInStockAndAvailable: false`) into results with a perfectly normal-looking record otherwise. Nothing about the response structure flags "don't show this as buyable" beyond that one field — see §6.5.

`get_cart`'s response was similarly inspected live: `items[]` with `spinId`, `skuId`, `itemName`, `quantity`, `mrp`, `discountedFinalPrice`, `imageUrl` per line, plus `cartTotalAmount` and a `billBreakdown` block. It also carries a large `selectedAddressDetails` object (full delivery address, lat/lng, phone number) that no caller needs — stripped before anything is shown to the model (§6.3).

---

## 3. Authentication — OAuth 2.1 + PKCE

`backend/src/auth/oauthClient.js` + `pkce.js` + `routes/auth.js`.

Swiggy's MCP servers require OAuth 2.1 with PKCE, phone+OTP login in the browser, and Dynamic Client Registration (DCR, RFC 7591) — there's no client ID to apply for, the client registers itself on first use.

**Flow, in order:**

1. **Metadata discovery** (`getServerMetadata`): fetches `https://mcp.swiggy.com/.well-known/oauth-authorization-server` (RFC 8414) to get the *actual* `authorization_endpoint`, `token_endpoint`, `registration_endpoint` — these are discovered at runtime, not hardcoded, because that's what the metadata document is for and it's the authoritative source.
2. **Dynamic Client Registration** (`ensureClientRegistration`): on first run, `POST`s to `registration_endpoint` with `{ redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], client_name }`. The resulting `client_id` is saved in SQLite (`oauth_client` table) and reused — registration only happens once.
3. **Authorization redirect** (`GET /auth/login` → `buildAuthorizationUrl`): generates a PKCE `code_verifier`/`code_challenge` pair (SHA-256) and a random `state`, stores the verifier in an **in-memory** `Map` keyed by state (deliberately not in SQLite — it only needs to survive the few seconds until the callback comes back), then redirects the browser to Swiggy's `authorization_endpoint`. The user completes phone+OTP login on Swiggy's own page.
4. **Callback** (`GET /auth/callback` → `handleAuthorizationCallback`): Swiggy redirects back with `?code=...&state=...`. The code is exchanged at `token_endpoint` for an access token, which is saved to SQLite (`oauth_token` table, single row). The browser is then bounced back to the frontend origin.
5. **Every tool call** goes through `getValidAccessToken()`, which reads the token from SQLite and throws `NeedsReauthError` if it's missing or past `expires_at`.

**Three important, non-obvious facts baked into this code:**

- **No refresh token in v1.** Swiggy's metadata advertises `refresh_token` as a supported grant type, but it isn't actually wired up server-side. So `NeedsReauthError` isn't a bug-to-patch-around — it's the intended behavior: the user must click "Connect Swiggy account" again. The whole app treats a 401 as "go log in again," never as "silently refresh."
- **Token exchange includes `client_id`** even though Swiggy's own doc sample didn't show it in the request body — per RFC 6749 §3.2.1, a public client (`token_endpoint_auth_method: "none"`) has no secret to authenticate with, so it must still identify itself via `client_id` at the token endpoint, or the standard flow doesn't work. This was a deliberate, reasoned addition, not a guess.
- **A valid token doesn't guarantee a working connection.** The cached MCP connection itself can go stale independent of token validity — see §2.2's `"fetch failed"` incident. Token expiry and connection staleness are two separate failure modes with two separate fixes (re-auth vs. drop-and-reconnect); conflating them would mean a stale-connection failure incorrectly sends the user through a full re-login they don't need.

The token is **only ever stored in SQLite on the backend** — the frontend never sees it, never stores it, and every Swiggy-calling route goes through the backend's own `getValidAccessToken()`.

---

## 4. Feature 1: Feast Finder (`backend/src/food/`)

### 4.1 The route: `GET /api/food/compare?dish=...&vegMode=...`

`routes/food.js` validates `vegMode` (`veg` | `nonveg` | `all`, default `nonveg`), calls `discoverRestaurantsForDish({ dish, addressId, vegMode })`, sorts the result by restaurant rating (descending) with distance (ascending) as tiebreak, and returns it — along with `suggestedTerms` (§4.5) when the search came up empty. All the real work is in `discoveryAgent.js`.

### 4.2 `discoveryAgent.js` — the pipeline, step by step

```
search_restaurants(dish)
        │
        ▼
filter to availabilityStatus === "OPEN"
        │
        ▼
[if zero] → Groq: normalizeQuery (spelling correction) → retry once
        │
        ▼
[if still zero] → Groq: expandSearchTerms (broader terms, §4.5)
                   → re-search each in parallel, keep only terms
                     that found something → "try instead" chips
        │
        ▼
[if still zero] → return { restaurants: [], suggestedTerms }
        │
        ▼
Groq: selectCandidates
  "which of these ~10-30 restaurants (name + cuisines) are
   plausible for this dish?" → up to 10 restaurantIds
        │
        ▼
mapWithConcurrency (4 at a time):
  scoped search_menu(dish, restaurantId, vegFilter?) per candidate
  → vegMode "veg" uses the native vegFilter=1; "nonveg" filters
    client-side (!item.isVeg && !item.veg); "all" keeps everything
        │
        ▼
Groq: judgeRelevantItems
  ONE call covering ALL restaurants' surviving items at once —
  "which menu_item_ids are genuinely this dish?" (food knowledge,
   not keyword matching)
        │
        ▼
sort each restaurant's surviving items by item rating, slice to top 6
        │
        ▼
Groq: estimateNutrition
  ONE call over the final (small) displayed item set —
  "estimate protein/kcal from the name"
        │
        ▼
return { restaurants: [...] }
```

Five distinct, narrow, single-purpose Groq helper functions (`normalizeQuery`, `expandSearchTerms`, `selectCandidates`, `judgeRelevantItems`, `estimateNutrition`), each a **bounded** call (one round-trip, forced tool-call output where structured data is needed) rather than an agentic loop — and the first two only run at all on the zero-result fallback path, so a normal successful search costs exactly three Groq calls (`selectCandidates`, `judgeRelevantItems`, `estimateNutrition`), same as before query expansion was added.

#### Why separate bounded calls, not one call or a loop

Each call operates on a different, progressively smaller/more-specific set of data, and answers a genuinely different kind of question. Combining them would mean re-sending large item lists to a judgment call that doesn't need them, or vice versa. The alternative — an agentic loop where the model decides everything turn by turn — was tried first and is the subject of the next paragraph.

#### The two incidents that ruled out an agentic loop here

**Incident 1 — latency.** The first implementation had the model call `search_restaurants` once, then loop, calling scoped `search_menu` one restaurant at a time inside a single growing conversation (the same pattern the Instamart chat originally used, see §6.3 — this codebase hit the exact same failure mode twice, in two different features, independently). This *worked*, but took **2.5–5 minutes per search**. The cause: each loop turn re-sends the *entire accumulating transcript* to the model, so per-call latency grew from ~1s to ~25s by the ~8th restaurant checked, and the model never actually batched its tool calls together despite being asked to. Splitting into "one bounded selection call, then parallel deterministic tool calls with no LLM in the loop at all" cut this to **~4–20 seconds**.

**Incident 2 — a rate-limit ceiling that looked like a different bug.** Groq's free tier caps requests at **8000 tokens/minute** — checked *per request* (prompt tokens + the requested `max_tokens` budget together), not just cumulative usage (a separate, worse version of this same ceiling later resurfaced in Pantry Pal — see §6.3). Early on, `judgeRelevantItems` had `max_tokens: 16384` (added to avoid response truncation) — which by itself already exceeds the entire ceiling for a single call, causing outright `413` rejections on larger searches. This surfaced initially as what looked like a *relevance* bug (restaurants showing wrong, unfiltered items) — the failure was silently falling back to "trust everything," which reproduced the exact bug the relevance judgment exists to prevent. Two fixes followed: `max_tokens` lowered to 4096 (fits safely), and the failure-fallback changed to **trust nothing** — a rate-limit hiccup now means *fewer* results, never *wrong* results. This asymmetry (fail closed, not open) is deliberate: for a price-comparison tool, showing fabricated matches is worse than showing an incomplete list. `createCompletionWithRetry` (`agent/groqClient.js`) also adds one automatic retry specifically for `429`s, since hitting the ceiling is routine on this tier, not exceptional.

### 4.3 Veg/non-veg/all filtering

`search_menu` has a `vegFilter` parameter, but per the tool's own schema it only supports **veg-only** (`1`) or **mixed** (`0`/omitted) — there is no "non-veg only" mode on the tool itself. So:

- **"veg"** passes `vegFilter: 1` — the cheapest option, Swiggy excludes non-veg server-side.
- **"nonveg"** fetches mixed results and filters client-side: `!item.isVeg && !item.veg` (the `isVeg`/`veg` field is only ever present, truthily, on items that *are* vegetarian in the samples observed — its absence is treated as non-veg).
- **"all"** fetches mixed results and keeps everything, unfiltered.

The frontend renders this as a three-pill toggle above the search box; each item also shows a small veg/non-veg dot so mixed ("all") results stay legible at a glance.

### 4.4 The relevance-judgment call in detail — why keyword matching wasn't enough

The first fix for "`search_menu` returns loosely-related junk instead of empty" was a strict filter: every significant word in the dish query had to appear in the item's name (e.g. "butter chicken" requires both "butter" *and* "chicken" in the name). This correctly excluded a biryani specialist's menu from a "butter chicken" search. But it broke the opposite case: a genuine burger specialist ("Good Flippin' Burgers") names its dishes creatively — "The Cluckinator," "The Kerfuffle," "The Saucy Clucker" — none of which contain the literal word "burger," so 4 of its 5 real burgers were wrongly excluded.

Telling "a real match with a creative name" apart from "a loosely-related fallback item" is a judgment call, not a string-matching problem — so `judgeRelevantItems` replaced the keyword filter with a single LLM call that's given every candidate restaurant's items at once and asked which `menu_item_id`s are genuinely the requested dish, using real-world food knowledge. This is a *food knowledge* task, not a search task, which is exactly what an LLM is suited for and a regex isn't.

### 4.5 Zero-result recovery: spelling, then broader terms, then "try instead" chips

Two layered fallbacks run only when `search_restaurants` finds nothing, in order:

1. **Spelling normalization** (`normalizeQuery`) — a plain-text completion (no tools) correcting things like "biriyani" → "biryani". Retried once.
2. **Query expansion** (`expandSearchTerms`) — the deeper fix, for a different failure mode entirely: `search_restaurants` is a name/cuisine-**tag** match, not a dish search, so it finds nothing for something like "alfaham" or "chicken pasta" unless a nearby restaurant's name or cuisine tag literally contains that text — even when a real match exists under a different label (an Arabian grill genuinely serving alfaham, a pasta place that doesn't have "chicken pasta" in its cuisine tags). The fix is an LLM call that suggests **broader**, never narrower, terms — the base dish with qualifiers stripped ("chicken pasta" → "pasta"), the cuisine ("italian", "arabian"), or the general category ("burger", "biryani") — re-searched in parallel. Only terms that actually returned a restaurant become "try instead" chips shown to the user; a term that itself found nothing is silently dropped rather than offered as a dead-end suggestion. Crucially, the *expanded* term is only ever used to widen the `search_restaurants` candidate pool — every step after this (scoped `search_menu`, `judgeRelevantItems`) still judges against the **original** dish text, so a loose synonym can only add candidates, never cause a false match.

Verified live: "alfaham" (no restaurant nearby had that word in its name/tags) resolved via expansion to "Arabian Mandi", correctly surfacing real Al Faham dishes; "chicken pasta" resolved via "pasta" + "italian" to real matches that a literal search of "chicken pasta" never would have found.

### 4.6 The dish randomiser — frontend-only, no backend call

A "surprise me" dice button next to the search box fills the input from `frontend/src/data/dishes.js`, a curated list of dishes each tagged `veg` / `nonveg` / `either`. It respects the currently-active veg/non-veg/all filter (only suggesting dishes compatible with it) and avoids repeating the dish already in the box. This is deliberately pure client-side logic — there's no reason to spend a backend round-trip, let alone an LLM call, picking a random string from a fixed list.

### 4.7 `couponCheck.js` — on-demand real pricing, one item at a time

This exists because of another dead-end: `fetch_food_coupons` (the tool CLAUDE.md's original design relied on for read-only, no-cart coupon pricing) **returns a bare `{}` in every case tested** — with or without a cart, even for a specific coupon code. It's non-functional in the current Swiggy MCP beta.

The only way to get a *real* coupon price is to build an actual cart: Swiggy auto-suggests and applies its single best coupon the moment a cart exists (visible in the cart's `offers.coupon_applied` / `offers.coupon_discount` fields). So `checkBestCoupon`:

1. Re-searches the menu (fresh, not trusting a possibly-stale `menuItemId` from the original discovery call — price/stock can change between page-load and click).
2. Builds a cart with just that one item (`update_food_cart`).
3. Reads the auto-suggested coupon code, explicitly applies it (`apply_food_coupon` — the auto-suggestion alone reports `discount: 0` until applied), then re-fetches the cart for the real discounted total.
4. **Always flushes the cart afterward** (`flush_food_cart`, in a `finally` block) — this app keeps no persistent food cart; every check is a build-then-discard.

Because a Swiggy food cart is single-restaurant and global (not scoped per-session in a way this backend can parallelize), concurrent coupon checks would clobber each other's cart — so `checkBestCoupon` calls are serialized through a simple promise chain (`let queue = Promise.resolve()`), one at a time, regardless of how many "check deal" buttons the user clicks in quick succession. The check is per **item**, not per restaurant — a restaurant can show several matching items, and each has a different price, so each needs its own coupon-eligibility check.

This is also why the UI shows a "Check best coupon & real price" button per item rather than pricing every item automatically — it's an explicit, mutating (cart-touching) action, gated behind a user click, matching the project's original rule that the cart is only touched on explicit user action.

---

## 5. Why Groq, and what that costs

The project originally used Anthropic's SDK with its native MCP connector (a hosted feature where Anthropic's own infrastructure executes remote MCP tool calls for you, server-side, transparently). It was switched to Groq for cost — Groq's free tier serves fast open-weight models (currently `openai/gpt-oss-120b`) for no cost, but:

- **No server-side MCP execution.** Groq is "just" an inference endpoint with OpenAI-style function-calling — it has no equivalent of Anthropic's MCP connector. Every tool call the model requests has to be executed by *this backend's own code* and the result fed back manually. This is the entire reason `agent/toolLoop.js` exists (§6.1).
- **A real, low rate-limit ceiling (8000 TPM on the free tier)** that shapes design decisions directly: keeping `max_tokens` low, batching data into as few calls as possible, the "fail closed" fallback behavior described in §4.2, and — the deeper version of this problem, found later while profiling Pantry Pal — the ceiling isn't just "one big request can exceed it," it's a **rolling per-minute cumulative quota**: a session making several back-to-back completions can get progressively throttled as it climbs toward the ceiling, even when every individual request is a very reasonable size. Measured directly: identical-sized completions within one session went 3.7s → 19.7s → 29s → 26.8s → 41.4s, a pattern that tracks cumulative usage, not any single request's cost. See §6.3 — this is *why* the fix for Pantry Pal's slowness was "make fewer completions happen at all," not just "make each one smaller."
- **`gpt-oss-120b` is a reasoning model** — it spends tokens on a hidden chain-of-thought pass before producing its actual answer. An early bug (`normalizeQuery` returning `null` for every query) turned out to be `max_tokens: 20` being entirely consumed by reasoning tokens before the model ever wrote its answer (`finish_reason: "length"`, empty `content`). Every Groq call in this codebase sets `reasoning_effort: "low"` and a token budget with real headroom, specifically because of this.
- **`createCompletionWithRetry`** (`agent/groqClient.js`) wraps every Groq call with one automatic retry specifically for `429` (rate limit) errors, since hitting the TPM ceiling is routine on this tier during ordinary back-to-back use, not an edge case.

---

## 6. Feature 2: Pantry Pal (`backend/src/agent/`)

**This section describes the current (third) design.** The first version was a pure agentic loop where the model decided everything, every turn. The second version added a guided brand/variant picker but still had the model decide, via two more LLM-callable tools, whether to ask a clarifying question or show results. Both were measured and replaced — read §6.3 before assuming "the model should decide X" is the right instinct here; for almost everything in this feature, it measurably isn't.

### 6.1 `toolLoop.js` — the hand-rolled agent loop

Since Groq won't execute tools for us, this is a manual implementation of the same idea, shared by Feast Finder's bounded single-purpose calls (§4) and Pantry Pal's multi-turn chat:

1. Send the conversation + tool definitions to Groq.
2. If the model's response has no `tool_calls`, we're done — return its text.
3. If it does, execute each requested tool call — **concurrently** if the model batched several into one turn — via `executeTool(name, args)`.
4. Push a `role: "tool"` message per result back into the conversation, and loop back to step 1.
5. Two independent ways a call can end the loop *without* costing another completion:
   - **`finalToolNames`** — the model itself calls a designated tool, and its arguments are handed back to the caller without ever being executed (used historically for Feast Finder's now-superseded discovery-loop pattern and the second-version `ask_choice`/`present_products` tools — see §6.4).
   - **The `__endLoop` sentinel** — `executeTool` itself can resolve to `{ __endLoop: true, kind, payload }`. The tool *did* run for real (its side effects happened, e.g. a real `search_products` call), but the *caller's own code*, not the model, has already decided what the final answer is from the result — so there's no reason to feed it back and pay for a second completion just to have the model restate a decision that was already made deterministically. This is the mechanism that makes §6.4's guided search work in one completion instead of two.

The generic loop doesn't know or care *why* something ended it — both mechanisms converge to the same `{ text, finalArgs, finalToolName, executedTools }` return shape.

### 6.2 `instamartAgent.js` — two tiers, not one loop

The model's job is now deliberately narrow: **interpret free text into either a `search_products` query, or a cart-editing/checkout tool call.** Its tool list (7 tools: `search_products`, `get_cart`, `update_cart`, `clear_cart`, `your_go_to_items`, `get_payment_options`, `checkout`) no longer includes `get_addresses`, `get_orders`, or `track_order` — dropped specifically to shrink the schema resent on every completion.

Everything downstream of "the model decided to search, or decided to edit the cart" is either fully deterministic or, for genuine free-text cart edits, still model-driven but on a much smaller payload:

- **Address**: resolved server-side from the saved address and injected into every tool call by `makeExecuteTool(addressId)` — the model never sees, asks for, or reasons about one. This alone removed an entire `get_addresses` round-trip (and the address-list JSON) from every turn.
- **Search results and cart reads/writes are compacted before the model ever sees them** — `compactForModel`/`compactSearchResult` strip heavy media/description fields and cap arrays from `search_products`/`your_go_to_items` results (still shown to the model for the free-text-question case, e.g. "what are my usuals?"); `compactCartForModel` strips `get_cart`/`update_cart`'s large `selectedAddressDetails` and formatted `billBreakdown` block down to just `{items: [{spinId, skuId, itemName, quantity, price}], total}` for the LLM tool-calling path (the deterministic direct actions below use the *real* uncompacted client directly, since they're not paying any token cost either way).
- **Conversation history is trimmed** to the last 8 user turns; the two transcripts (`conversation`, what the LLM sees, vs `displayTranscript`, what the UI renders — rich choice/product messages) are kept separate so trimming the LLM's context never drops something the UI needs to redraw on reload.
- **`max_tokens: 1024`** for the chat loop (Feast Finder's bounded calls use their own, smaller budgets per call — see §4.2).

### 6.3 The incident that drove this: measuring and fixing a 129-second guided add

The trigger was a direct user report: Pantry Pal felt slow and was burning through the Groq quota fast. Rather than guess, the fix started with instrumentation — `toolLoop.js` now logs, per completion: wall-clock time, request size in raw characters, and Groq's own `usage` numbers (prompt/completion/reasoning tokens). Running the actual guided flow ("add milk" → "Amul" → click Add) through the real code with this logging produced:

| Step | Groq calls | Time | Notable |
|---|---|---|---|
| "add milk" → brand question | 2 | 4.3s | fine |
| "Amul" → variant cards | 2 | 24.6s | second call: 19.7s for a 297-token reply |
| Click Add on a card | 3 | **100.2s** | 29s, 26.8s, 41.4s for 23-, 59-, and 39-token replies |

The smoking gun: completion duration climbed steadily through the session (3.7s → 19.7s → 29s → 26.8s → 41.4s) while the actual output sizes stayed tiny and roughly constant. A 23-token reply does not take 29 seconds on Groq's inference hardware because the *prompt* is large — Groq processes thousands of tokens per second. This pattern (worsening latency, disproportionate to any single request's content) is the signature of hitting the free tier's rolling per-minute quota and getting increasingly queued as a session's *cumulative* usage climbs (§5) — not any one request being oversized.

That reframed the fix: the lever that matters most is **the number of completions**, not just each one's size. Clicking "Add" on a card — where the frontend already knows the exact `spinId`/`skuId` — was costing **three** completions (decide to call `get_cart`, decide to call `update_cart`, generate a text reply) for an action with exactly one correct outcome. That's the origin of the deterministic direct actions in §6.4 and §6.5. Measured result after the rework, same three-step scenario: **7 completions / ~129s → 1 completion / ~2s** (only the very first "add milk" step still needs a completion, to turn free text into a search query; everything after that is zero-LLM).

### 6.4 The guided brand/variant flow — and why it isn't LLM-driven anymore

**This flow was built twice.** The first version added two new LLM-callable tools, `ask_choice` and `present_products`: the model would call `search_products`, see the (compacted) results, and then decide to call one of these two tools to ask a clarifying question or show variant cards. That worked, but cost exactly the kind of extra completion described in §6.3 — the model spending a full round-trip to decide something that was actually a deterministic function of the search results (how many distinct brands came back).

The current version removes `ask_choice`/`present_products` from the model's tool list entirely. `search_products` is still the only thing the model calls; what happens with the result is decided in `runSearchAndBranch()`, invoked from `executeTool`'s `search_products` case, immediately after the real search runs:

- **0 results** → `{ kind: "empty" }`, a templated "couldn't find X" reply, no LLM round-trip.
- **2+ distinct brands found** (deterministic — `brand` is a real field on the response, §2.5; a brand is only offered if it has at least one in-stock variant, §6.5) → `{ kind: "choice", question, options: [...brands, "Any brand"] }`.
- **Otherwise** → `{ kind: "products", items }` — up to 6 variants, sorted (§6.5), each resolved to a full card (photo, size, price) via the image side-channel (§6.7).

All three outcomes return via the `__endLoop` sentinel (§6.1) — the loop ends the instant `search_products` finishes, with zero additional completions.

**The brand follow-up is also zero-LLM.** When the previous turn asked "which brand?" with a real, closed set of options (`pendingBrandChoice`, module state), the *next* message is checked against that set (`matchOfferedBrand` — exact match first, then substring) *before* the LLM loop is even entered. If it matches, `runSearchAndBranch` runs again with `forceBrand` set (filtering to that brand and skipping the ask-again check) — again with zero completions. The "Any brand" option (`isAnyBrandChoice`, matching "any"/"all"/"any brand"/"all brands") is checked the same way and re-runs the search with `skipBrandAsk: true`, showing every variant found, mixed brands. This also fixed a real correctness bug from the first version: Swiggy's fuzzy search still surfaces other loosely-matched brands even in a brand-qualified query ("amul milk" can still return Chitale, Gokul, etc. as loose matches) — without `forceBrand` explicitly suppressing the re-ask, the app would ask "which brand?" a second time after the user had already answered once.

**Variants are shown in Swiggy's own order, not an LLM ranking.** An earlier design considered a bounded LLM call to "curate" which variants to show (mirroring §4.4's relevance-judgment pattern) — deliberately not built, in favor of trusting Swiggy's own search relevance/popularity ordering plus a deterministic stock/price sort (§6.5). Given §6.3's finding, adding back an LLM call here for something Swiggy's own ranking already does reasonably well wasn't worth the cost.

### 6.5 Out-of-stock handling, sorting, and Swiggy's unpredictable rejections

Three related, separately-discovered issues, all in the same area:

**Out-of-stock items were being offered as addable.** `search_products` mixes in-stock and out-of-stock variants freely (§2.5) with no visual distinction unless the app adds one. The original guided flow didn't check `isInStockAndAvailable`, so an out-of-stock card had a working "Add" button — clicking it made Swiggy reject the update wholesale ("All items in your cart are currently out of stock"), which then cascaded into every *subsequent* add failing too, since the merge logic (§6.6) always reads the current cart first. Fixed with several coordinated changes: variants are sorted in-stock-first (stable sort, so Swiggy's own relevance order is preserved *within* each group) with **price ascending as the secondary key** on every results screen — a single brand, "Any brand," or a "show more" page; out-of-stock cards render visibly marked (dimmed photo, "Out of stock" badge) with a disabled button; a brand is only offered as a choice if it has at least one in-stock variant; and `addItemDirect` guards server-side against adding a known-out-of-stock item, independent of whatever the UI shows.

**Some items report in-stock but Swiggy rejects them anyway, unpredictably.** Confirmed live and repeatedly: a specific fresh-meat item (`isInStockAndAvailable: true`, a fully-populated product record) still failed `update_cart` with `"No valid items in cart"` on some attempts and succeeded on others, with no code change in between and no way to predict it from the search response. This can't be filtered client-side the way the previous paragraph's case can — there's no signal to filter on. The response is UX, not prevention: `friendlyCartError()` maps Swiggy's raw multi-line error text (report IDs, support email) to a short, actionable phrase — "Swiggy isn't letting this one be added right now — try a different size or brand" — and, critically, a failed add never blocks or cascades into the next one (verified: adding a different, working item immediately after a failed one succeeds normally).

**A `get_cart` failure over one item's stock state can "poison" the cart.** Every subsequent read — including the read every deterministic mutation starts with — fails identically until the cart is cleared. Confirmed live: `clear_cart` succeeds even while `get_cart` is stuck this way, and reads work normally again immediately after. `friendlyCartError()` detects this specific message pattern ("partially available") and points the user at "Clear cart" as the concrete fix, rather than a dead-end error.

### 6.6 Reliability: idempotent retries, and the stale-connection bug they exposed

`update_cart` and `clear_cart` are both **idempotent** — `update_cart` always *replaces* the cart with the given item list, so replaying the identical call lands on the same end state, never a duplicate side effect; `clear_cart` on an already-empty cart is a no-op. `instamartClient.js` wraps both in one automatic retry on any failure (`callWithRetry`, 700ms delay) — the same reasoning already used for Groq's `429` retry (§5), applied to Swiggy's own tool calls.

This is **deliberately not applied to `checkout`/`confirm_order`** — those create real orders and aren't idempotent; retrying one blindly on a transient failure could create a duplicate order. A checkout failure must surface to the user, never be silently retried.

Adding this retry surfaced a second, more interesting bug: a card's Add button intermittently failed with a raw `"fetch failed"` — not a Swiggy tool rejection at all, a Node-level network error. Tracing it: the *same* call through a *fresh* MCP client (a brand-new Node process) succeeded instantly, while the long-running backend's cached connection kept failing identically on every attempt, including the retry — because the retry was retrying through the *same broken cached connection*. The real fix was one layer down, in `mcpClient.js` (§2.2): network-level failures now drop the cached connection, not just 401s, so the retry actually gets a fresh connection instead of repeating the same dead one's failure. Verified: 5 rapid successive adds all succeeded at the connection level after this fix (the last two hit a legitimate, different, correctly-surfaced Swiggy business rule — a per-item quantity cap — not a bug).

One more Swiggy-specific trap found while building the cart's quantity stepper (§6.7): `update_cart` **rejects an empty items array outright** (`"items array is required and must contain at least one item"`) — so decrementing the last remaining item in the cart to zero can't go through `update_cart` with `items: []`; it has to go through `clear_cart` instead. Both the stepper's direct action and the LLM tool-calling path's `update_cart` handler check for this and reroute to `clear_cart` when the computed item list would be empty.

### 6.7 The image side-channel

Product photos never reach the model — they're one of the fields `compactForModel` strips (§6.2) to keep token cost down. So a server-side cache, keyed by `spinId` (and `skuId`), holds the *full* variant record (photo, brand, size, price, stock) every time `search_products`/`your_go_to_items` runs (`cacheProducts()`). When `runSearchAndBranch` builds a `products` result, it resolves each chosen variant ref back to its full card via this cache (`enrichProducts()`) — the model (when it's involved at all) only ever handles bare ids, never image URLs.

The live cart needed no such cache: `get_cart`'s own response already includes `imageUrl` per line item directly (§2.5), so `CartSummary` reads it straight from the real field names.

### 6.8 Deterministic direct actions — the other half of §6.3's fix

Five backend functions bypass the LLM loop entirely, each backing a specific UI affordance that has exactly one correct outcome once its input is known:

| Action | Function | What it does |
|---|---|---|
| Click "Add" on a card | `addItemDirect` | Out-of-stock guard (§6.5) → `get_cart` → merge in the known `spinId`/`skuId` → `update_cart` |
| "Show more options" | `showMoreDirect` | Paginates through the already-cached, already-sorted variant list from the last search — no new Swiggy call unless that list is exhausted |
| "Reorder my usuals" | `reorderUsualsDirect` | `your_go_to_items`, filtered to in-stock, merged into the cart |
| "Clear cart" | `clearCartDirect` | `clear_cart`, then re-fetch to confirm |
| Cart +/- quantity stepper | `setItemQuantity` | `get_cart` → set that item's quantity (or drop it entirely at 0, rerouting to `clear_cart` if that empties the cart, §6.6) → `update_cart` |

All five update `displayTranscript` directly (so the UI's rich rendering stays consistent whether an action came from the model or from code) — **except the quantity stepper**, which deliberately does *not* log to the chat transcript at all. A +/- click isn't a conversation event the way "add milk" or clicking a product card is; logging every stepper click would spam the chat log the way no real e-commerce cart's stepper does. Each of these is exposed as its own small Express route (`/add-item`, `/show-more`, `/reorder-usuals`, `/clear-cart`, `/set-quantity`) alongside the existing `/chat` route, so the frontend calls the right one directly instead of routing everything through the chat endpoint with a synthetic message.

### 6.9 "Most ordered by you" — cross-referencing `your_go_to_items` into search

**The problem this solves:** a broad request like "add a protein bar" or "add chicken" returns an undifferentiated grid of brands/products with no signal about which one the user actually, personally buys. The app already had a real Swiggy-provided answer to "what does this user usually order" sitting unused for this purpose — `your_go_to_items`, wired in since earlier work but only ever called for the explicit "Reorder my usuals" button.

**Design decision: Swiggy's live data, not a local order log.** `db.js` has an `order_history` table, but it's a summary-blob log written only by the Food side (`routes/food.js`); Instamart checkouts write nothing to it, and even if they did it would only cover orders placed through this dashboard going forward, not the user's real Swiggy history. `your_go_to_items` already *is* Swiggy's own frequency/recency signal, confirmed live to return the same `products[]`/`variations[]` shape as `search_products` (§2.5) — so cross-referencing against it costs one extra MCP call, not a new subsystem, and it reflects the user's actual full order history from day one rather than starting cold.

**How the cross-reference works (`instamartAgent.js`):**

1. `getGoToIndex(addressId)` fetches `your_go_to_items` once and builds two lookup maps: `bySpinId` (exact variant match — the same pack size the user actually bought) and `byKey`, a `brand::displayName` fallback so a *different* pack size of a product they buy regularly still counts. A product's position in Swiggy's own returned list becomes its `rank` (0 = most preferred) — the same "trust Swiggy's own ordering, don't re-score it" principle already applied to variant sort order in §6.4.
2. Cached for 5 minutes per `addressId` (`GO_TO_CACHE_TTL_MS`) — long enough that a multi-step guided flow (search → brand pick → variant pick) doesn't refetch it three times, short enough to stay fresh across a session. Explicitly invalidated the moment `checkout` succeeds, so the order just placed counts on the very next search rather than waiting out the TTL.
3. A failure fetching `your_go_to_items` (brand-new account, transient error) is swallowed to an empty index — this is a best-effort enrichment signal, never allowed to block a normal search.
4. `runSearchAndBranch` fetches `search_products` and `getGoToIndex` **in parallel** (`Promise.all`) so the added round-trip costs `max(search, goToFetch)`, not their sum, on the cache-miss path.

**What the user sees:** `flattenVariants` tags each variant with `mostOrdered`/`orderRank`; `sortVariants` promotes matched variants above the existing in-stock/price sort (§6.5); `enrichProducts` sets the existing (previously unused) `note` field to `"(Most ordered by you)"` on a matched card — the frontend already renders `product.note` as a small badge line (`ProductCard` in `InstamartChat.jsx`), so **no frontend change was needed**. For the brand-choice screen, `brandGoToRanks` aggregates the same per-variant ranks up to brand level (best rank among any of that brand's variants in these results) and the matched brand is both moved to the front of the offered list and suffixed `" (most ordered by you)"` in its displayed label.

**A subtlety that would have been a real bug:** the brand-choice flow's `pendingBrandChoice.brandsOffered` — the list `matchOfferedBrand` and `forceBrand` filtering key off on the next turn — must stay the **clean** brand-name strings, never the annotated display label. Only the `options` array actually sent to the frontend gets the `" (most ordered by you)"` suffix. Since the frontend echoes the exact clicked label back as the next chat message, and `matchOfferedBrand`'s substring check (`t.includes(bl)`) still matches the clean name as a prefix of the annotated one, this works without any change to the matching logic itself — but conflating the two lists (annotating `brandsOffered` directly) would have broken `forceBrand`'s exact-match filter, since no real Swiggy `brand` field ever equals `"Godrej Real Good (most ordered by you)"`.

### 6.10 Search relevance filtering — fixing `search_products` noise deterministically

**The problem:** `search_products`, like `search_menu` on the Food server (§2.4), doesn't return empty when nothing genuinely matches — it falls back to loosely/semantically related items. Confirmed live: searching "chicken" surfaced "Too Yumm Protein Chips" (no literal relation to chicken at all) mixed in alongside real chicken products, and this reached the user as an apparently-broken guided picker.

**Why not another LLM relevance-judgment call** (mirroring Feast Finder's `judgeRelevantItems`, §4.4): §6.3's whole point was measuring that per-turn LLM calls were the actual latency/cost problem for this feature (129s for one guided add), and the fix was replacing model judgment with deterministic code wherever the decision didn't actually need real reasoning. A relevance *filter* on product names is exactly that kind of decision.

**The fix (`filterRelevantProducts` in `instamartAgent.js`):** tokenize the query into its significant words (lowercased, stopwords like "a"/"add"/"my" stripped, with a cheap plural/singular tolerance — "cookies" still matches a "Cookie" product name), then keep only products whose `displayName` or `brand` contains at least one of those words. This is applied once, at the top of `runSearchAndBranch`, before caching or branching, so every downstream consumer (brand grouping, variant cards, "show more" pagination) sees the same filtered set.

**Known, accepted limitation:** this is a literal keyword filter, not a semantic one — "Suhana Chicken Masala" and "ZOFF Marinade Mix-Chicken Chettinad" both literally contain the word "chicken" and survive the filter even though neither is raw chicken meat. Distinguishing "chicken (the protein)" from "chicken (the flavor)" would need real semantic judgment, i.e. an LLM call per search — deliberately not built, given §6.3's finding. What the filter *does* reliably kill is the "Too Yumm Protein Chips"-class noise: results with zero literal word overlap with the query at all, which was the actual complaint.

**Safety valve:** if the filter would remove every result (a query where Swiggy's match was purely semantic, no literal overlap anywhere), it's skipped and the unfiltered set is used instead — the same "don't report a false empty result" principle already used when `forceBrand` doesn't match anything exactly (§6.4).

---

## 7. Frontend (`frontend/src/`)

Plain React + Vite, no state-management library — each panel owns its own `useState`.

- **`App.jsx`** — a sidebar (`Sidebar.jsx`) toggles between two `hidden`-attribute-gated panes: `DishCompare` (Feast Finder) and `InstamartChat` (Pantry Pal). Both are always mounted, only visibility toggles, so switching tabs never loses in-progress state.
- **`AuthGate.jsx`** wraps everything — checks `/auth/status` on load, shows a "Connect Swiggy account" link (→ `/auth/login`, handled entirely server-side) if not authenticated.
- **`api.js`** is a thin `fetch` wrapper (`request(path, options)`) with one piece of shared logic: a 401 (or `error: "NEEDS_REAUTH"`) response throws a typed `ApiError` that callers check with `isReauthError(err)` to show a re-auth prompt instead of a generic error (`ReauthNotice.jsx` is the shared UI for it). It also exposes the deterministic direct-action endpoints (§6.8) as distinct methods alongside `instamartChatSend`.
- **`AddressPicker.jsx`** — shared between both panels; lists saved addresses via the Food `/api/food/addresses` route and persists the chosen one server-side. Pantry Pal's address bar sits at the top of the panel, not inside the chat itself — the chat agent never asks for an address (§6.2).
- **`DishCompare.jsx`** — renders the veg/non-veg/all pill toggle, the "surprise me" randomiser button (§4.6), the restaurant list (each item row independently manages its own coupon-check loading/result state), and, on a zero-result search, the "try instead" suggestion chips (§4.5).
- **`InstamartChat.jsx`** — renders the chat transcript, including two message types beyond plain text: `choice` (clickable brand chips, including the dashed "Any brand" option, §6.4) and `products` (an image-card grid, each with a price and Add button, out-of-stock ones visibly marked and disabled, §6.5). Quick-action chips ("Reorder my usuals," "Clear cart") and each card's "Add" button call the deterministic direct-action endpoints, not the chat endpoint.
- **`CartSummary.jsx`** — reads the real, confirmed `get_cart` field names directly (`itemName`, `discountedFinalPrice`, `cartTotalAmount`, `imageUrl`, `spinId`, `skuId`), with defensive fallback key names kept in case a field is ever missing. Each line item renders a +/- quantity stepper (§6.8) that calls `/set-quantity` directly — a plain cart edit, not a chat action.
- **`ProductThumb.jsx`** — a shared image tile (product cards + cart rows) that falls back to a clean placeholder rather than a broken-image icon when a photo is missing or fails to load, matching the same "never fake or drop it" policy Feast Finder's dish photos already used.

---

## 8. Data storage (`backend/src/db.js`)

SQLite, `backend/data/app.db` (gitignored — holds the live OAuth token). Single-user design shows up directly in the schema: most tables use `id INTEGER PRIMARY KEY CHECK (id = 1)` — a deliberate "singleton row" pattern (one client registration, one token, one saved address at a time), upserted via `ON CONFLICT(id) DO UPDATE`.

| Table | Purpose |
|---|---|
| `oauth_client` | DCR result — `client_id` (+ secret if any), the redirect URI it was registered with |
| `oauth_token` | The single active access token + its expiry |
| `saved_address` | The one delivery address both Feast Finder and Pantry Pal use |
| `coupon_cache` | Dead code — was meant to cache `fetch_food_coupons` results; unused since that tool was confirmed non-functional (§4.7) and coupon pricing moved to an on-demand cart-build flow with nothing cacheable |
| `order_history` | Append-only log of placed orders — only the food `/order` route logs to this table today; Instamart `checkout` is fully wired and callable from chat (gated by the system prompt's explicit-confirmation rule), it just isn't logged here yet |

Pantry Pal's conversation state (`conversation`, `displayTranscript`, the product image cache, `pendingBrandChoice`, `lastSearchContext`) is deliberately **not** in SQLite — it's in-memory, module-level state in `instamartAgent.js`, reset on server restart or explicit "Reset conversation." Appropriate for a single-user local tool where losing an in-progress chat on restart is a non-issue, and persisting it would add real complexity for no benefit.

---

## 9. Error handling

Central pattern in `server.js`: every route is `async`, and Express 5 automatically forwards rejected promises to the error-handling middleware (no manual `try/catch` + `next(err)` boilerplate needed in routes). That middleware maps:

- `NeedsReauthError` → `401 { error: "NEEDS_REAUTH", loginUrl: "/auth/login" }`
- `SwiggyToolError` whose message looks like a 401/unauthorized → same, since Swiggy's own 401s mean the same thing (no refresh token — re-auth)
- Any other `SwiggyToolError` → `502 { error: "SWIGGY_TOOL_ERROR", tool }`
- Anything else → logged server-side, `500`

This is the *outermost* layer, catching whatever reaches it. Two layers sit underneath it that resolve problems before they ever get here: `mcpClient.js`'s connection-cache invalidation and retry (§2.2, §6.6) handle transport-level failures by reconnecting and retrying transparently, and `instamartAgent.js`'s `friendlyCartError()` (§6.5) turns Swiggy's own raw tool-rejection text into a short, specific message *before* it would otherwise bubble up as a generic 502. By the time an error reaches this middleware, it's already something neither of those layers could recover from.

The frontend's `api.js` mirrors the 401 case: any 401-shaped response becomes a typed `ApiError` that every panel checks for and renders as a re-auth prompt rather than a generic error message.

---

## 10. Summary: the shape of the whole system

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Browser (React)                                                          │
│  ┌──────────────────┐              ┌──────────────────────────────────┐   │
│  │  Feast Finder     │              │  Pantry Pal                     │   │
│  │  (DishCompare)    │              │  (InstamartChat + CartSummary)  │   │
│  └────────┬──────────┘              └─────────────────┬────────────────┘  │
└───────────┼─────────────────────────────────────────────┼────────────────┘
            │ fetch (/api/food/*)                          │ fetch (/api/instamart/*)
┌───────────▼─────────────────────────────────────────────▼────────────────┐
│  Express backend (localhost:8787)                                        │
│                                                                            │
│  routes/food.js ─── discoveryAgent.js ──┬── foodClient (MCP: Food)        │
│      │                                   ├── Groq: normalizeQuery         │
│      │                                   ├── Groq: expandSearchTerms      │
│      │                                   ├── Groq: selectCandidates       │
│      │                                   ├── Groq: judgeRelevantItems     │
│      └── couponCheck.js                  └── Groq: estimateNutrition      │
│              └── foodClient (MCP: Food, cart build/apply/flush)           │
│                                                                            │
│  routes/instamart.js                                                     │
│      ├── /chat ─── instamartAgent.sendMessage ─── toolLoop.js            │
│      │                  ├── runSearchAndBranch (deterministic, __endLoop) │
│      │                  ├── Groq (free-text → search query / cart edit)   │
│      │                  └── instamartClient (MCP: Instamart)              │
│      └── /add-item, /show-more, /reorder-usuals,                         │
│          /clear-cart, /set-quantity ─── direct actions, ZERO Groq calls   │
│                  └── instamartClient (MCP: Instamart, retry-wrapped)      │
│                                                                            │
│  routes/auth.js ─── oauthClient.js (OAuth 2.1 + PKCE + DCR)               │
│                                                                            │
│  db.js (SQLite: token, client reg, saved address, order log)             │
└───────────┬────────────────────────────────────────────┬─────────────────┘
            │ StreamableHTTP + Bearer token,               │ HTTPS
            │ reconnect-on-network-failure (§2.2)          │ (chat completions)
┌───────────▼──────────────┐                    ┌──────────▼──────────────┐
│  mcp.swiggy.com/food      │                    │  api.groq.com            │
│  mcp.swiggy.com/im        │                    │  (openai/gpt-oss-120b)  │
└────────────────────────────┘                    └──────────────────────────┘
```

Two independent external dependencies, two independent sets of failure modes to design around: Swiggy's MCP servers (auth expiry, connection staleness, tools that don't behave as documented, inventory data that's unreliable in ways that can't be predicted from the response) and Groq (rate limits that get worse the more you rely on them, reasoning-token quirks). The single biggest structural lesson across both features, learned twice independently (§4.2's Incident 1 and §6.3): an agentic loop that lets the model decide *everything* is the easiest thing to build first and the first thing worth measuring and replacing — most of what looks like "the model's job" turns out to have exactly one correct answer once you look at the actual data, and code can decide that instantly for free.
