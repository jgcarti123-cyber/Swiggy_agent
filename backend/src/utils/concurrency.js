// Rate-limit doc (https://mcp.swiggy.com/builders/docs/operate/rate-limits.md) warns
// that firing fetch_food_coupons across many restaurants unthrottled risks the
// ~4 req/s burst ceiling. Cap how many run at once instead of Promise.all-ing everything.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
