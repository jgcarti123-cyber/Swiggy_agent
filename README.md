# Swiggy Personal Dashboard

A personal, single-user, local-only dashboard built on Swiggy's official Builders Club MCP servers. One page, a sidebar, two tools:

- **Feaster** — type a dish, see nearby open restaurants that serve it, ranked by rating, filtered by veg/non-veg/all, with item photos, LLM-estimated nutrition, and an on-demand real coupon price per item. Zero-result searches get "try instead" suggestions instead of a dead end.
- **Insta-nt** — a chat that turns plain text ("add milk", "order things for making biryani") into real Instamart cart actions, with a web-grounded recipe flow and a per-item Q&A popup. Broad requests get a guided brand → size picker with photos and a quantity stepper; there's an editable "usuals" list with an optional daily auto-add, and you can even import a cart screenshot from another app to reorder it here.

Not a product, not multi-tenant — this is one person's own dashboard for their own Swiggy account, run on `localhost`. Not affiliated with or endorsed by Swiggy; built against their public Builders Club developer platform.

## Highlights

- **Measured a real bottleneck, then fixed it with data.** The chat agent started as a pure "the model decides everything" loop — it worked, but was measured at **7 Groq completions and ~129 seconds** for one guided add. Profiling showed most of what looked like "agent reasoning" was actually deterministic: searching, branching into a brand question or product cards, adding to cart. Rebuilt that flow **deterministic-first**, model only where real judgment is needed — down to **0–2 completions** per turn.
- **Caught an LLM fabricating a fact, and closed it with code, not a bigger prompt.** Adversarial-tested the per-item "Explain" feature with a deliberately fictional product. The search API's own synthesized summary invented a specific nutrition figure for it, sourced from an unrelated brand's page — and the model repeated it as fact, *even after* the prompt was explicitly told sources might describe other products. Prompting didn't hold, so the fix is a deterministic relevance filter: a source only counts if it verifiably mentions the product in question.
- **Every documented API behavior verified against the live server, not assumed.** Several didn't match: an "unscoped" search the docs describe as working returns nothing on the live beta; a coupon-fetch tool always returns `{}`; a cart-merge bug that silently doubled quantities under a specific race condition. Each is fixed and the discovery process recorded in `ARCHITECTURE.md` — not glossed over.

## Insta-nt in action

<!--
  Screenshots go in docs/screenshots/ — see docs/screenshots/SHOTLIST.md for the
  exact steps to reproduce each one (search terms, click order, what should
  render). Replace this comment block with the four <img> rows once captured.
-->

| | |
|---|---|
| ![Guided brand picker → product grid](docs/screenshots/insta-nt-brand-picker.png) | ![Per-item Explain popup, web-grounded answer with sources](docs/screenshots/insta-nt-explain.png) |
| *"add milk" → deterministic brand question → product cards, zero LLM calls after the first* | *The ℹ️ "Explain" popup: a real, sourced answer — not a guess* |
| ![Recipe flow grounded in a real web recipe](docs/screenshots/insta-nt-recipe.png) | ![Live cart reflecting real Swiggy state](docs/screenshots/insta-nt-cart.png) |
| *"order things for making biryani" — ingredient list grounded in an actual recipe, not just model recall* | *The cart panel always reflects the real, verified Swiggy cart — never a guess from "the call didn't throw"* |

## Why this exists

Swiggy's MCP servers expose ordering as callable tools instead of a REST API, which makes them naturally agent-friendly — but a lot of documented behavior turned out not to match the live beta (an unscoped dish search that always returns empty, a coupon-fetch tool that returns `{}`, a veg filter with no non-veg-only mode, a response envelope that only sometimes wraps). Every gap like that is fixed and recorded here, not glossed over.

The Instamart chat agent also has its own story worth knowing before touching it: it started as a pure "the model decides everything" loop, which worked but was measured at **7 Groq completions and ~129 seconds for a single guided add**. Most of that flow — searching, branching into a brand question or product cards, adding to cart, reordering usuals — is now **deterministic backend code**, not the model deciding. See `ARCHITECTURE.md` for the full account.

## Setup

Requires Node 18+, a free [Groq API key](https://console.groq.com), and a Swiggy account.

```bash
git clone https://github.com/jgcarti123-cyber/Swiggy_agent.git
cd Swiggy_agent

cd backend
npm install
cp .env.example .env   # fill in GROQ_API_KEY at minimum
npm run dev             # http://localhost:8787

# in a second terminal
cd frontend
npm install
npm run dev             # http://localhost:5173
```

Open `http://localhost:5173`, click "Connect Swiggy account" (OAuth 2.1 + PKCE with phone + OTP — the same login as the Swiggy app), then use either panel. Access tokens last 5 days and don't refresh, so you'll be prompted to reconnect after that.

Optional: a free [Tavily API key](https://tavily.com) (`TAVILY_API_KEY` in `.env`) grounds the recipe flow and the per-item Explain popup in real web content. Both features work without it — they just fall back to the model's own knowledge, clearly marked as such.

## Stack

React + Vite frontend, Node/Express backend, SQLite for local state (OAuth token, saved address, editable usuals list, order history — never leaves the machine), Groq (`openai/gpt-oss-120b`) for the LLM pieces, Tavily (optional) for web-grounded answers, the official `@modelcontextprotocol/sdk` talking directly to `mcp.swiggy.com`. The backend binds to `127.0.0.1` only and is the only thing that ever holds the Swiggy token — the frontend never calls Swiggy directly.

## Docs

- **`CLAUDE.md`** — the quick-reference brief: which Swiggy tools are actually called, what's verified to *not* work as documented, and the current shape of both features. Read this before changing anything that touches a Swiggy tool call.
- **`ARCHITECTURE.md`** — the detailed record: every verified Swiggy quirk, every Groq rate-limit incident, and the full history of how Insta-nt went from a slow pure-LLM loop to a mostly-deterministic one, with measured before/after numbers.

## Scope

Single user, localhost only. No multi-tenant auth, no public deployment, no Telegram bot, no Dineout integration, no automated checkout without an explicit click.
