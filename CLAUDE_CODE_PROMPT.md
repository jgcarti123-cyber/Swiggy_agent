# Claude Code prompt

Put this in the project directory alongside `CLAUDE.md`, then paste the block below into Claude Code to kick off the build.

---

Read `CLAUDE.md` in this directory fully before doing anything else. It defines the exact scope, the Swiggy MCP tools you're allowed to use, and the doc URLs you must verify against before writing any Swiggy-related code. Do not invent tool names, parameters, or auth details — if something isn't covered in `CLAUDE.md` or the linked docs, stop and ask me instead of guessing.

Build a local-only, single-user web dashboard with two panels on one page:

1. **Food dish compare** — I type a dish name, it shows me nearby open restaurants that serve it, each with its price, the best available coupon, and the effective price after that coupon, sorted so the best deal is easiest to spot.
2. **Instamart chat** — a chat box where I type what I want in plain language ("add 2 bananas and a liter of milk") and an LLM agent with the Instamart MCP tools attached handles search, cart updates, and checkout, with a live cart summary next to the chat that always reflects the real cart state, not just what the model says.

Work in this order:

1. Fetch `https://mcp.swiggy.com/builders/llms.txt`, then fetch the specific tool docs referenced in `CLAUDE.md` for `search_menu`, `fetch_food_coupons`, and the Instamart tools, and confirm the parameters before writing any integration code.
2. Scaffold the project: React + Vite frontend, Node/Express backend, SQLite for local state, as described in `CLAUDE.md`.
3. Implement the OAuth 2.1 + PKCE flow against Swiggy MCP (localhost redirect URI, dev/staging only for now) and store the resulting token server-side only.
4. Build the food dish-compare panel per the flow in `CLAUDE.md` — one `search_menu` call, then parallel `fetch_food_coupons` calls across the restaurants that come back, filtering out anything not `OPEN`.
5. Build the Instamart chat panel using Anthropic's SDK with its native MCP connector attached to the Instamart server. Re-fetch `get_cart` after every cart-touching tool call and render the live cart from that, not from the model's own summary.
6. Style the whole thing to match Swiggy's visual language — orange/black/white, rounded cards, bold type, pill-shaped filters, rating badges — per the UI section in `CLAUDE.md`. Do not use Swiggy's actual logo or copyrighted assets, just the color and layout language.
7. Add basic error handling: a 401 should prompt me to re-authenticate rather than fail silently; restaurants with `availabilityStatus` of `CLOSED` or `UNAVAILABLE` should be filtered out rather than shown as orderable.
8. When done, tell me how to run it locally, and call out anything that still needs a production Swiggy access application versus what already works against localhost/staging.

Build incrementally: get the food comparator working end-to-end first with minimal styling, then the Instamart chat, then apply the full visual design last.
