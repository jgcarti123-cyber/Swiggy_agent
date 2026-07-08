import { foodClient } from "../mcp/foodClient.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { createCompletionWithRetry } from "../agent/groqClient.js";
import { config } from "../config.js";

const MAX_CANDIDATES = 10;
const SEARCH_CONCURRENCY = 4; // same ~4 req/s burst ceiling as the coupon fetch
const MAX_ITEMS_PER_RESTAURANT = 6;

const SELECT_TOOL = {
  type: "function",
  function: {
    name: "select_candidates",
    description:
      "Return the restaurant ids most likely to actually serve the requested dish, ranked most-plausible first.",
    parameters: {
      type: "object",
      properties: {
        restaurantIds: {
          type: "array",
          items: { type: "string" },
          description: `Up to ${MAX_CANDIDATES} restaurant ids, most plausible first`,
        },
      },
      required: ["restaurantIds"],
    },
  },
};

const RELEVANCE_TOOL = {
  type: "function",
  function: {
    name: "report_relevant_items",
    description:
      "For each restaurant, report which menu_item_ids are genuinely the requested dish, using real-world food knowledge — not literal keyword matching. Creatively/branded-named items (e.g. \"The Cluckinator\" at a burger place) DO count if they actually are that dish. Exclude items that are a different dish that merely shares an ingredient or cuisine (e.g. a plain chicken biryani is NOT butter chicken).",
    parameters: {
      type: "object",
      properties: {
        matches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              restaurantId: { type: "string" },
              menuItemIds: {
                type: "array",
                items: { type: "string" },
                description: "menu_item_ids at this restaurant that are genuinely the requested dish",
              },
            },
            required: ["restaurantId", "menuItemIds"],
          },
        },
      },
      required: ["matches"],
    },
  },
};

// A first pass here (search_restaurants unscoped, then a growing sequential
// tool-calling loop checking one candidate at a time via search_menu) worked
// but took 2.5-5 minutes: each loop turn re-sends the whole accumulating
// transcript, so per-call latency ballooned from ~1s to ~25s by the ~8th
// candidate, and the model never actually batched calls despite being asked
// to. Splitting into one bounded LLM call (candidate selection) plus
// parallel deterministic search_menu checks (no LLM in that loop at all)
// avoids both problems.
export async function discoverRestaurantsForDish({ dish, addressId }) {
  let searchResult = await foodClient.searchRestaurants({ addressId, query: dish });
  let openRestaurants = extractOpenRestaurants(searchResult);

  // search_restaurants is spelling-sensitive: an off-spelling query (e.g.
  // "biriyani" vs "biryani") can make it silently fall back to returning
  // dish-name records with no availabilityStatus/rating/etc at all, which
  // this filters out, correctly, as zero valid restaurants. Ask the model
  // for a normalized spelling and retry once before giving up.
  if (openRestaurants.length === 0) {
    const corrected = await normalizeQuery(dish).catch(() => null);
    if (corrected && corrected.toLowerCase() !== dish.toLowerCase()) {
      searchResult = await foodClient.searchRestaurants({ addressId, query: corrected });
      openRestaurants = extractOpenRestaurants(searchResult);
    }
  }

  if (openRestaurants.length === 0) {
    return { restaurants: [] };
  }

  const metaById = new Map(openRestaurants.map((r) => [String(r.id), r]));
  const selectedIds = await selectCandidates(
    dish,
    openRestaurants.map((r) => ({ id: r.id, name: r.name, cuisines: r.cuisines }))
  );

  const checked = await mapWithConcurrency(selectedIds, SEARCH_CONCURRENCY, async (restaurantId) => {
    const menuResult = await foodClient.searchMenu({
      addressId,
      query: dish,
      restaurantIdOfAddedItem: restaurantId,
    });
    const items = Array.isArray(menuResult?.items) ? menuResult.items : [];

    // Non-veg only, per user preference. search_menu's vegFilter param only
    // supports veg-only (1) or mixed (0/omitted) — there's no non-veg-only
    // filter on the tool itself, so this filters client-side. isVeg/veg is
    // only present (truthy) on veg items in samples seen; its absence is
    // treated as non-veg.
    const nonVegItems = items.filter((item) => item.menu_item_id && !item.isVeg && !item.veg);
    if (nonVegItems.length === 0) return null;

    const meta = metaById.get(String(restaurantId));
    return {
      restaurantId: String(restaurantId),
      restaurantName: meta?.name,
      distanceKm: meta?.distanceKm,
      deliveryTimeMinutes: meta?.deliveryTimeMinutes,
      rating: meta?.avgRating,
      items: nonVegItems.map((item) => ({
        menuItemId: String(item.menu_item_id),
        name: item.name,
        price: item.price,
        rating: item.rating ? Number(item.rating) : null,
        // Swiggy only returns a photo for some items within a restaurant
        // (often under half) — no fallback substitution, the frontend shows
        // an explicit "no photo available" placeholder for the rest.
        imageUrl: item.imageUrl || null,
      })),
    };
  });

  const withMatches = checked.filter(Boolean);
  if (withMatches.length === 0) return { restaurants: [] };

  // A real Swiggy behavior: when a restaurant has no genuine match, scoped
  // search_menu doesn't return an empty list — it falls back to
  // loosely-related items from that menu (verified live: querying "butter
  // chicken" at a biryani specialist returned 10 items, none of them butter
  // chicken). A strict keyword filter fixed that but broke the opposite case
  // — restaurants with creatively-named items that ARE genuine matches (e.g.
  // "The Cluckinator" at a burger specialist) got wrongly excluded, since
  // "burger" never appears in the name. Telling real matches from loose
  // fallback results is a judgment call, not a string-matching problem, so a
  // single bounded LLM pass judges relevance across all restaurants at once.
  const relevantIdsByRestaurant = await judgeRelevantItems(dish, withMatches);

  const ranked = withMatches
    .map((restaurant) => {
      const relevantIds = relevantIdsByRestaurant.get(restaurant.restaurantId);
      const items = (relevantIds ? restaurant.items.filter((i) => relevantIds.has(i.menuItemId)) : [])
        .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
        .slice(0, MAX_ITEMS_PER_RESTAURANT);
      return { ...restaurant, availabilityStatus: "OPEN", items };
    })
    .filter((r) => r.items.length > 0);

  return { restaurants: ranked };
}

function extractOpenRestaurants(searchResult) {
  return (Array.isArray(searchResult?.restaurants) ? searchResult.restaurants : []).filter(
    (r) => r.availabilityStatus === "OPEN"
  );
}

// Single bounded LLM call across ALL restaurants at once (not a per-restaurant
// loop) — judges which items are genuinely the requested dish using food
// knowledge, so it correctly keeps creatively-named real matches (see
// discoverRestaurantsForDish) while still dropping loosely-related fallback
// items.
//
// On any failure (call error, truncated response, malformed JSON) this
// returns an EMPTY map — i.e. trust nothing — rather than trusting every
// item. Trusting everything on failure would silently reintroduce the exact
// bug this function exists to fix (fake matches shown as real), which is a
// worse failure mode for a price-comparison tool than occasionally showing
// fewer restaurants than are actually available.
async function judgeRelevantItems(dish, restaurantsWithItems) {
  const empty = new Map();

  const payload = restaurantsWithItems.map((r) => ({
    restaurantId: r.restaurantId,
    restaurantName: r.restaurantName,
    items: r.items.map((i) => ({ menuItemId: i.menuItemId, name: i.name })),
  }));

  try {
    const completion = await createCompletionWithRetry({
      model: config.groqModel,
      reasoning_effort: "low",
      messages: [
        {
          role: "system",
          content: `You judge whether menu items are genuinely the dish "${dish}", using real-world food knowledge — not literal keyword matching. Creatively or brand-named items (e.g. "The Cluckinator" at a burger restaurant) DO count if they actually are that dish. Exclude items that are a different dish and merely share an ingredient or cuisine (e.g. a chicken biryani is NOT butter chicken). Call report_relevant_items exactly once, covering every restaurant given, even with an empty menuItemIds array if nothing there matches.`,
        },
        { role: "user", content: JSON.stringify(payload) },
      ],
      tools: [RELEVANCE_TOOL],
      tool_choice: { type: "function", function: { name: "report_relevant_items" } },
      max_tokens: 4096,
    });

    const choice = completion.choices[0];
    if (choice.finish_reason !== "tool_calls") {
      console.error(
        `[judgeRelevantItems] non-terminal finish_reason="${choice.finish_reason}" for dish="${dish}" (${restaurantsWithItems.length} restaurants) — treating as no matches rather than risking a truncated parse.`
      );
      return empty;
    }

    const toolCall = choice.message.tool_calls?.[0];
    if (!toolCall) {
      console.error(`[judgeRelevantItems] no tool_call in response for dish="${dish}"`);
      return empty;
    }

    const args = JSON.parse(toolCall.function.arguments || "{}");
    const matches = Array.isArray(args.matches) ? args.matches : [];
    return new Map(
      matches.map((m) => [String(m.restaurantId), new Set((m.menuItemIds || []).map(String))])
    );
  } catch (err) {
    console.error(`[judgeRelevantItems] failed for dish="${dish}": ${err.message}`);
    return empty;
  }
}

// Plain-text completion, no tools — just asks for a corrected spelling.
// reasoning_effort "low" + a real token budget: gpt-oss models spend tokens
// on a hidden reasoning pass before the answer, and max_tokens=20 (this
// call's original budget) was entirely consumed by reasoning, leaving the
// actual content empty with finish_reason "length".
async function normalizeQuery(dish) {
  const completion = await createCompletionWithRetry({
    model: config.groqModel,
    reasoning_effort: "low",
    messages: [
      {
        role: "system",
        content:
          "You correct likely misspellings or spelling variants of food dish names into the most standard spelling for restaurant search (e.g. 'biriyani' -> 'biryani', 'panir' -> 'paneer'). Reply with ONLY the corrected search term, nothing else — no punctuation, no explanation.",
      },
      { role: "user", content: dish },
    ],
    max_tokens: 200,
  });
  return completion.choices[0].message.content?.trim().replace(/^["']|["']$/g, "") || null;
}

// Single bounded LLM call — forced to answer via one tool call, so this is
// exactly one round-trip, not a loop. Judgment (which restaurants are
// actually plausible for this dish) is the one part worth spending a model
// call on; everything else here is a direct, deterministic MCP tool call.
async function selectCandidates(dish, candidates) {
  if (candidates.length === 0) return [];

  const completion = await createCompletionWithRetry({
    model: config.groqModel,
    reasoning_effort: "low",
    messages: [
      {
        role: "system",
        content: `You pick which restaurants are most likely to serve a specific dish, based on name and cuisine tags. Call select_candidates exactly once with up to ${MAX_CANDIDATES} restaurant ids, most plausible first.`,
      },
      { role: "user", content: `Dish: "${dish}"\nCandidates: ${JSON.stringify(candidates)}` },
    ],
    tools: [SELECT_TOOL],
    tool_choice: { type: "function", function: { name: "select_candidates" } },
    max_tokens: 1024,
  });

  const toolCall = completion.choices[0].message.tool_calls?.[0];
  if (!toolCall) return candidates.slice(0, MAX_CANDIDATES).map((c) => String(c.id));

  try {
    const args = JSON.parse(toolCall.function.arguments || "{}");
    const ids = Array.isArray(args.restaurantIds) ? args.restaurantIds.map(String) : [];
    return ids.length > 0 ? ids.slice(0, MAX_CANDIDATES) : candidates.slice(0, MAX_CANDIDATES).map((c) => String(c.id));
  } catch {
    return candidates.slice(0, MAX_CANDIDATES).map((c) => String(c.id));
  }
}
