(function (root) {
  "use strict";

  async function runSequential(items, processItem, { shouldStop = () => false, onResult = () => {} } = {}) {
    const results = [];
    for (const item of items) {
      if (shouldStop()) break;
      try {
        const result = await processItem(item);
        results.push({ item, ok: true, result });
        onResult(results.at(-1));
      } catch (error) {
        results.push({ item, ok: false, error: error.message });
        onResult(results.at(-1));
      }
    }
    return results;
  }

  const api = { runSequential };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaQueue = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
