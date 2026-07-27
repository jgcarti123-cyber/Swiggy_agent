# Swiggy Personal Dashboard

A personal, single-user, local-only dashboard built on Swiggy's official Builders Club MCP servers. One page, a sidebar, two tools:

- **Feaster** — type a dish, see nearby open restaurants that serve it, ranked by rating, filtered by veg/non-veg/all, with item photos, LLM-estimated nutrition, and an on-demand real coupon price per item. Zero-result searches get "try instead" suggestions instead of a dead end.
- **Insta-nt** — a chat that turns plain text ("add milk", "order things for making biryani") into real Instamart cart actions. Broad requests get a guided brand → size picker with photos and a quantity stepper; there's an editable "usuals" list with an optional daily auto-add, and you can even import a cart screenshot from another app to reorder it here.

Not a product, not multi-tenant — this is one person's own dashboard for their own Swiggy account, run on `localhost`. Not affiliated with or endorsed by Swiggy; built against their public Builders Club developer platform.

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

## Stack

React + Vite frontend, Node/Express backend, SQLite for local state (OAuth token, saved address, editable usuals list, order history — never leaves the machine), Groq (`openai/gpt-oss-120b`) for the LLM pieces, the official `@modelcontextprotocol/sdk` talking directly to `mcp.swiggy.com`. The backend binds to `127.0.0.1` only and is the only thing that ever holds the Swiggy token — the frontend never calls Swiggy directly.

## Docs

- **`CLAUDE.md`** — the quick-reference brief: which Swiggy tools are actually called, what's verified to *not* work as documented, and the current shape of both features. Read this before changing anything that touches a Swiggy tool call.
- **`ARCHITECTURE.md`** — the detailed record: every verified Swiggy quirk, every Groq rate-limit incident, and the full history of how Insta-nt went from a slow pure-LLM loop to a mostly-deterministic one, with measured before/after numbers.

## Scope

Single user, localhost only. No multi-tenant auth, no public deployment, no Telegram bot, no Dineout integration, no automated checkout without an explicit click.
