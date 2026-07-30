# Video script — Insta-nt walkthrough

Target length: 90-120 seconds. Screen recording + your own voice narration, portfolio-length (not a full tutorial). Structure: hook → live demo → two engineering stories → CTA.

Record the screen first following the on-screen actions, then narrate over it (or narrate live if you're comfortable doing both at once — the timings below assume live).

---

### 0:00-0:10 — Hook (face-to-camera or voiceover over the empty app)
**Say:**
"I built a chat agent that turns plain text into real Swiggy Instamart orders — using their new MCP servers. This is Insta-nt. Two things about it are worth more than the demo itself, so let me show you both."

**On screen:** Insta-nt panel, empty/fresh chat state.

---

### 0:10-0:35 — Live demo, guided add
**Say (while doing the actions):**
"Say I just type 'add milk'."

**Do:** Type `add milk`, send.

**Say:** "It doesn't guess — it asks which brand, because there are several real options. I pick one..."

**Do:** Click a brand.

**Say:** "...and now I'm looking at real product cards: real photos, real prices, real stock status, straight from Swiggy's catalogue."

**On screen:** Product grid rendering.

---

### 0:35-0:55 — Story 1: the performance rewrite
**Say:**
"Here's the first thing worth knowing. The very first version of this agent asked the LLM to decide every single step — search, ask, add to cart, all of it. It worked. But I measured it: **seven Groq completions and about 129 seconds** for this exact interaction."

**On screen:** could show a simple text overlay or just narrate over the same product grid — "7 calls / 129s → 0-2 calls" (add this as a text card if editing, otherwise just say it).

**Say:** "Most of what looked like 'agent reasoning' was actually deterministic — the same branch every time. So I rebuilt it: the model only runs where real judgment is needed. Everything else is plain code now. Same interaction today: zero to two completions."

---

### 0:55-1:15 — Story 2: catching the LLM lying
**Say:**
"Second thing. Insta-nt has a per-item 'ask about this' popup — grounded in real web search, not just the model's memory."

**Do:** Click the ℹ️ on a product card, ask "is this good for a diabetic?" (or your captured question), wait for the answer with sources.

**Say:** "While testing this, I fed it a fictional product on purpose. The search API's own summary invented a nutrition number for it — pulled from a completely unrelated brand's page. And the model repeated it as fact, even after I told it explicitly in the prompt that sources might not match. The prompt didn't hold."

**Say:** "So the fix isn't a bigger prompt — it's a deterministic check in code: a source only counts if it actually mentions this exact product. Simple rule, closes a real hallucination."

---

### 1:15-1:30 — Bonus beat (only if you're under 120s and want one more): recipe grounding
**Say:**
"It also handles fuzzier requests — 'order things for making biryani' searches a real recipe and grounds the ingredient list in it, instead of just whatever the model remembers."

**Do:** Show the recipe checklist with the "based on real recipes from the web" note.

---

### 1:30-1:45 — CTA
**Say:**
"Everything here — the rewrite, the hallucination catch, every Swiggy API quirk I had to work around — is documented in the repo, link's below. Thanks for watching."

**On screen:** GitHub repo URL / README.

---

## Recording tips
- Do the demo actions first, quietly, to make sure the timing/response speed is what you expect (Groq + Tavily calls take a couple seconds) — then record for real once you know the rhythm.
- If a step lags on the actual recording, keep talking over it (the narration above has enough words to cover a 2-3s wait) rather than cutting and re-recording.
- Trim the bonus beat (0:55-1:15 recipe section) first if you're running long — the two core stories (rewrite + hallucination catch) are the ones that matter most for the portfolio framing.
