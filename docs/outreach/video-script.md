# Video script — Insta-nt full walkthrough

Target length: **~4-5 minutes**. This version follows the exact same flow as the README's "Insta-nt in action" section — guided search → Explain → recipe grounding → usuals/auto-add → import from a screenshot — so the video and the README reinforce each other instead of telling two different stories. Every "Do" step below maps to a screenshot already in `docs/screenshots/` (`Search_1/2`, `info_1/2`, `recipe_1/2/3`, `usuals`, `dup_1/2/3`), so you already know exactly what each moment looks like.

Each section below has three parts: **Say** (narration), **Do** (on-screen action), and **The catch** — one punchy, technical, slightly surprising fact to land per section. These are the lines that make a viewer go "wait, really?" instead of just watching a feature demo. Don't rush past them.

Record the demo actions first (quietly, once) to get the real response timing in your head — Groq + Tavily calls take a couple of seconds — then record for real once you know the rhythm.

---

### 0:00–0:15 — Hook
**Say:**
"This is Insta-nt — a chat agent that turns plain text into real Swiggy Instamart orders. I'm not just going to show you what it does. I'm going to show you the five times it broke, and how I actually caught each one."

**On screen:** Insta-nt panel, empty welcome state.

**The catch:** Every section after this has a real bug in it — not hypothetical, not "best practices," bugs I found by testing against my own real account and fixed with evidence, not guesses.

---

### 0:15–1:00 — Guided search: "add milk" → brand picker → product grid → cart
**Say (while doing the actions):**
"Say I type 'add milk'."

**Do:** Type `add milk`, send. (Matches `Search_1.png`.)

**Say:** "It doesn't guess. It asks which brand — because Instamart genuinely returns half a dozen real ones — and Amul's flagged 'most ordered by you,' pulled from my actual Swiggy order history, not made up."

**Do:** Click a brand, show the product grid.

**Say:** "Here's the thing — that brand question you just saw? Zero AI involved. It's one line of code counting how many brands came back: two or more, ask; one, just show it. The only place the model actually runs is turning 'add milk' into a search term in the first place."

**Do:** Scroll to the rest of the grid, click Add on Amul Moti Toned Milk, show "Added ✓". (Matches `Search_2.png`.)

**Say:** "And that checkmark isn't the model saying 'done' — the backend re-reads the real cart after every add to confirm the item actually landed. I found out the hard way that Swiggy's own cart API can report success while silently dropping an item, or worse, double the quantity on a retry. Now nothing gets marked added until it's actually verified in the cart."

**The catch:** The very first version of this whole agent asked the model to decide *every single step* — search, ask, add, confirm. It worked, but I measured it: **7 Groq completions, ~129 seconds**, for the exact interaction you just watched. Today: 0 to 2 completions. Same result, a fraction of the calls — because almost none of that was really "AI reasoning," it was the same decision every time, just dressed up as a model call.

---

### 1:00–1:50 — Explain: grounded Q&A, not a guess
**Say:**
"Every product card has an ℹ️. It opens a scoped Q&A about that one item — backed by real web search, not the model's memory."

**Do:** Click ℹ️ on Amul Taaza Milk, ask "is this good for a diabetic?", show the answer with sugar-content figures and `[1][2][3]` sources. (Matches `info_1.png`.)

**Say:** "That's not a guess — it's grounded in real search results, and it cites them."

**Do:** Switch to `info_2.png` — the bedsheet. Ask "which is better for winter, satin or cotton?", show the **"💭 General knowledge — not specific to this listing"** answer, then ask "what are the measurements?" and show the precise, sourced answer.

**Say:** "Notice it answered those two questions completely differently, on purpose. One's a general comparison — it doesn't pretend that's specific to this product, it labels it as recalled knowledge. The other is a specific fact about this exact listing, and that one's cited. A cited fact and a recalled one never look the same in this app."

**The catch:** I adversarial-tested this with a completely fictional product. The search API's own AI-generated summary *invented* a nutrition figure for it — lifted straight from an unrelated brand's real page — and the model repeated it as fact, even after I explicitly told it in the prompt that sources might not match. The prompt didn't hold. The fix wasn't a bigger prompt — it's one deterministic rule in plain code: a source only counts if it actually, verifiably mentions *this* product. That's the difference between an AI that sounds confident and one that's actually right.

---

### 1:50–2:50 — Recipe grounding: from a dish name to a real, Indian recipe
**Say:**
"Now the fuzzy request: 'order things for making biryani.'"

**Do:** Type it, show the 16-ingredient checklist with the **"🔎 Based on real recipes from the web — [1][2][3]"** note. (Matches `recipe_1.png`.)

**Say:** "That list isn't the model remembering biryani from training data — it did a real web search first, then built the ingredient list from actual recipe pages. Confirm it, and each ingredient gets searched and matched independently."

**Do:** Show `recipe_2.png` — Cinnamon, Cloves, Cardamom, Bay Leaf each auto-matched "✓ In cart," each with 2 swap alternatives visible.

**Say:** "If one auto-pick is wrong, that's a one-click swap, not a re-order."

**Do:** Show `recipe_3.png` — the final cart, 12 ingredients plus a chicken cut, ₹596, with a couple of items already swapped by hand.

**The catch #1 — the pasta problem:** Here's a bug that only shows up on a dish that isn't uniquely Indian. Ask for "pasta" with no grounding bias, and the web search returns a *generic, Western* pasta recipe — olive oil, basil, parmesan. This app is built specifically for an Indian household shopping an Indian catalogue, so that's just wrong. The fix: bias the search itself toward India — a real, documented parameter the search API supports — plus rewrite the query to say "Indian recipe." Same dish, same code, completely different result: real Indian food-blog recipes, and an ingredient list with cumin seeds, garam masala, kasuri methi. Not a translation trick — an actually different, correct recipe.

**The catch #2 — the AI that forgot its own job:** While testing all this, I found something else: about 1 in 3 identical "order things for making biryani" requests just... didn't trigger this feature at all. The model would reply with a plain paragraph instead of the checklist you're looking at — same request, different behavior, no pattern I could see at first. Turned out the code was letting the model freely choose whether to use its own tool, every single time. The fix: detect an unmistakable recipe request in code, and *force* the model to use the tool for that message. Reliability went from roughly 2-in-3 to 9-in-10. Not perfect — I'll say that on camera, not hide it — but a real, measured fix, not a guess.

---

### 2:50–3:20 — Usuals + daily auto-add
**Say:**
"There's also a 'usuals' list — a local, editable shortlist you build with a ☆ on any product."

**Do:** Show the `usuals.png` panel — 4 saved items, "Reorder now," the daily auto-add toggle.

**Say:** "Why local and not just Swiggy's own order history? Because Swiggy's list is read-only — I can't fix it if it's wrong, and I can't curate it. This one's mine to edit."

**Do:** Point out the notice: "Auto-add on 2026-07-29 was missed — the app wasn't running at the scheduled time."

**The catch:** That message is deliberate. The scheduler could have just silently skipped the run and said nothing — instead it tells you honestly when it failed. An app that hides its own failures is worse than one that admits them.

---

### 3:20–4:00 — Import from a screenshot
**Say:**
"Last one — you can literally hand it a screenshot of a cart from a *different* app."

**Do:** Show `dup_1.png` — the empty state with a screenshot staged in the input, "replicate this order," not yet sent.

**Say:** "Nothing uploads until I actually hit send."

**Do:** Show `dup_2.png` — the editable checklist read off that image, then `dup_3.png` — results: most items auto-matched and added, one item with no exact match showing three real alternatives instead of a guess.

**The catch:** Reading that image is the *only* place in this entire app that uses a vision model — everything else you've seen tonight is text. And it broke, silently, in production: the vision model I originally picked got quietly retired by the provider with zero warning, so every single import just failed with a generic "couldn't read that image" and no clue why. Found it by checking the actual API response directly instead of guessing. There's also a sharper bug underneath: for a while, it was capable of silently adding a ₹290 six-pack of chicken instead of the ₹145 single pack you actually had in the photo — a real, measurable, expensive mistake — traced down to how it cross-referenced my own order history. Fixed, verified, and written up. That's the whole point of this project: not that it never breaks, but that every break gets actually found and actually fixed.

---

### 4:00–4:20 — CTA
**Say:**
"Every one of these fixes — the rewrite, the hallucination catch, the recipe grounding, the reliability fix, the vision model outage, the pricing bug — is documented with the real before-and-after numbers in the repo. Link's below. Thanks for watching."

**On screen:** GitHub repo URL / README.

---

## Recording tips
- Do a silent dry run first so you know how long each real response actually takes (Groq + Tavily calls run a couple of seconds; don't let dead air surprise you on the real take).
- If a step lags during the real recording, keep talking over it — the narration above has enough words to cover a 2-3s wait — rather than cutting and re-recording.
- If you need to cut for time, cut **evenly** rather than dropping a whole section — losing one line from each "catch" hurts far less than losing the recipe-grounding or import sections entirely, since those carry two of the best stories.
- The two strongest "catches" for a portfolio audience, if you truly have to pick favorites, are the hallucination-catch (Explain) and the pricing bug (import) — both have a concrete number and a satisfying reveal. Don't cut either.
