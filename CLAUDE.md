# CLAUDE.md

## Project

A personal, single-user, local-only web dashboard built on the official Swiggy Builders Club MCP servers. One page, two panels:

1. **Food dish compare** — type a dish, see nearby open restaurants that serve it, ranked by price after the best available coupon.
2. **Instamart order chat** — a chat box where free-text messages ("add milk and bananas") are turned into Instamart search/cart/checkout actions by an LLM agent, with a live cart panel that always reflects the real cart state.

Runs on `localhost` only. Single user (the account owner). No multi-tenant auth, no public deployment, no Telegram bot, no Dineout — those are separate projects and explicitly out of scope here.

## Absolute rule: no hallucinated Swiggy tools or parameters

Before implementing any call to a Swiggy MCP tool, fetch and read the corresponding doc below. Never invent a tool name, parameter, error code, or auth detail. If a doc doesn't cover something you need, stop and ask rather than guessing — Swiggy's own agent-authoring guidance is explicit about this.

- Index of every doc: https://mcp.swiggy.com/builders/llms.txt
- Full text (only if you need broad context in one shot): https://mcp.swiggy.com/builders/llms-full.txt
- Any docs page as clean markdown: append `.md` to its URL
- Auth flow: https://mcp.swiggy.com/builders/docs/start/authenticate.md
- Error codes: https://mcp.swiggy.com/builders/docs/reference/errors.md
- Rate limits: https://mcp.swiggy.com/builders/docs/operate/rate-limits.md
- Connect an AI client (OAuth config reference): https://mcp.swiggy.com/builders/docs/start/consumer/use-in-ai-client.md
- Developer quickstart: https://mcp.swiggy.com/builders/docs/start/developer/index.md
- Build an agent (per-framework recipes, incl. Anthropic SDK's native MCP connector): https://mcp.swiggy.com/builders/docs/start/developer/build-an-agent.md
- Order food end-to-end recipe: https://mcp.swiggy.com/builders/docs/build/recipes/order-food.md
- Order groceries end-to-end recipe: https://mcp.swiggy.com/builders/docs/build/recipes/order-groceries.md
- Multi-turn cart state pattern: https://mcp.swiggy.com/builders/docs/build/agent-patterns/multi-turn-state.md
- Ship to production checklist: https://mcp.swiggy.com/builders/docs/build/ship-to-production.md
- Access & onboarding (only needed later, for production): https://mcp.swiggy.com/builders/docs/operate/access.md

## Servers

- Food — endpoint `mcp.swiggy.com/food`, reference index: https://mcp.swiggy.com/builders/docs/reference/food/index.md
- Instamart — endpoint `mcp.swiggy.com/im`, reference index: https://mcp.swiggy.com/builders/docs/reference/instamart/index.md
- Dineout — not used in this project.

They are independent: no shared carts, orders, or sessions between servers.

## Tools this project needs (fetch each `.md` before using)

**Food**
- `get_addresses` — https://mcp.swiggy.com/builders/docs/reference/food/get_addresses.md
- `search_menu` — https://mcp.swiggy.com/builders/docs/reference/food/search_menu.md — dish-level search. Confirmed from the docs: when called **without** `restaurantIdOfAddedItem`, it searches across restaurants near the address. This is the "find restaurants serving X dish" capability — do not build manual per-restaurant menu scanning.
- `search_restaurants` — https://mcp.swiggy.com/builders/docs/reference/food/search_restaurants.md — restaurant/cuisine name search only, not dish search. Not part of the dish-compare flow.
- `get_restaurant_menu` — https://mcp.swiggy.com/builders/docs/reference/food/get_restaurant_menu.md
- `fetch_food_coupons` — https://mcp.swiggy.com/builders/docs/reference/food/fetch_food_coupons.md — read-only, needs only `restaurantId` + `addressId`, no active cart required. Use this to estimate price-after-coupon across all candidate restaurants in parallel.
- `apply_food_coupon` — https://mcp.swiggy.com/builders/docs/reference/food/apply_food_coupon.md — only call once the user has actually chosen a restaurant and added items, to get the exact confirmed total.
- `update_food_cart` — https://mcp.swiggy.com/builders/docs/reference/food/update_food_cart.md
- `get_food_cart` — https://mcp.swiggy.com/builders/docs/reference/food/get_food_cart.md
- `place_food_order` — https://mcp.swiggy.com/builders/docs/reference/food/place_food_order.md
- `track_food_order` — https://mcp.swiggy.com/builders/docs/reference/food/track_food_order.md
- `flush_food_cart` — https://mcp.swiggy.com/builders/docs/reference/food/flush_food_cart.md
- `report_error` — https://mcp.swiggy.com/builders/docs/reference/food/report_error.md

**Instamart**
- `get_addresses` — https://mcp.swiggy.com/builders/docs/reference/instamart/get_addresses.md
- `search_products` — https://mcp.swiggy.com/builders/docs/reference/instamart/search_products.md
- `update_cart` — https://mcp.swiggy.com/builders/docs/reference/instamart/update_cart.md — **replaces the entire cart**, it is not additive. Read this doc carefully before wiring the chat agent's cart-update calls.
- `get_cart` — https://mcp.swiggy.com/builders/docs/reference/instamart/get_cart.md
- `checkout` — https://mcp.swiggy.com/builders/docs/reference/instamart/checkout.md — creates the order and confirms payment in one call. Only trigger this on an explicit user confirmation.
- `clear_cart` — https://mcp.swiggy.com/builders/docs/reference/instamart/clear_cart.md
- `your_go_to_items` — https://mcp.swiggy.com/builders/docs/reference/instamart/your_go_to_items.md
- `get_orders`, `get_order_details`, `track_order`, `create_address`, `delete_address`, `report_error` — see the reference index above for each

## Auth

OAuth 2.1 + PKCE with phone + OTP in the browser, per https://mcp.swiggy.com/builders/docs/start/authenticate.md. Dynamic Client Registration (RFC 7591) means there's no client_id to apply for manually during local dev — the MCP client library handles it. Access tokens last 5 days; **there is no refresh token in v1** — treat every 401 as "re-run the authorization flow," not as a bug to patch around. Store the token server-side only, never in frontend code or browser storage. Build against `http://localhost` redirect URIs first — no approval needed for this stage; production access is a separate, later step (see Access & onboarding doc above).

## Feature 1: Food dish compare

Flow: user types a dish → call `search_menu` with the saved `addressId` and the dish as `query`, omitting `restaurantIdOfAddedItem` so it searches across restaurants → group results by restaurant, filter out anything not `availabilityStatus: OPEN` → for each distinct restaurant found, call `fetch_food_coupons` in parallel (read-only, no cart needed) → compute an estimated best price per restaurant from the coupon terms and amounts → render a ranked list: restaurant name, dish + base price, best coupon, estimated effective price, rating, distance/ETA, sorted cheapest-effective-price first. Only touch the cart (`update_food_cart`, `apply_food_coupon`) once the user clicks to actually order from a specific restaurant, to get the exact confirmed total before `place_food_order`.

## Feature 2: Instamart chat

A chat panel where the user's free-text messages go to Claude via Anthropic's SDK, using its native MCP connector with the Instamart server's tools attached directly — the model decides which tool to call (search, cart update, checkout) from the conversation. After every tool call that touches the cart, re-fetch `get_cart` server-side and render the live cart summary from that response, not from the model's text description alone.

## UI: match Swiggy's visual language

Reference: https://www.swiggy.com — for layout and style direction only, not for copying their logo or other trademarked assets. Direction: Swiggy's signature orange (roughly `#FC8019`) as the primary accent for buttons and active states; near-black (roughly `#282C3F`) for headings and primary text; white or very light gray (`#F8F8F8`-ish) card backgrounds; generously rounded corners (10–16px) on cards and buttons; bold, confident sans-serif type; pill-shaped filter/category chips; a filled green rating badge with a star icon; delivery time shown as a small muted badge next to price. These hex values are from general knowledge of the brand, not pixel-sampled from the live site programmatically — inspect the real site (devtools or a screenshot) before locking in final design tokens. Do not use Swiggy's actual logo, wordmark, or other copyrighted imagery; use an original wordmark/icon in the same color language.

## Stack

React + Vite frontend, Node/Express backend, SQLite for local state (saved address id, cached menu/coupon lookups, order history). The backend is the only thing that talks to Swiggy MCP and holds the OAuth token; the frontend never calls Swiggy directly.

## Non-goals for this build

No Telegram bot. No multi-user support. No production Swiggy access application yet (build and test against `http://localhost` / dev only). No Dineout integration. No automated checkout without an explicit user click.

## Before shipping any Swiggy-calling code

Re-fetch the specific tool's `.md` doc and confirm the parameter names and types match what's written above — this file is a snapshot taken while planning; the live docs are the source of truth.
