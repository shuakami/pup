'use strict';

/**
 * Small, dependency-free promise pool.
 *
 * - Preserves input order.
 * - Concurrency-limited.
 * - Optional "stopOnError" to fail fast.
 *
 * @template T,R
 * @param {T[]} items
 * @param {(item:T, index:number)=>Promise<R>} worker
 * @param {{concurrency?:number, stopOnError?:boolean}} [opts]
 * @returns {Promise<R[]>}
 */
async function pMap(items, worker, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Number(opts.concurrency || 4));
  const stopOnError = opts.stopOnError !== false;

  const results = new Array(list.length);
  let nextIndex = 0;
  let failed = false;
  let firstError = null;

  async function runOne() {
    while (true) {
      if (failed && stopOnError) return;
      const i = nextIndex++;
      if (i >= list.length) return;

      try {
        results[i] = await worker(list[i], i);
      } catch (e) {
        if (!firstError) firstError = e;
        failed = true;
        if (stopOnError) return;
        results[i] = null;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, list.length); i++) {
    workers.push(runOne());
  }
  await Promise.all(workers);

  if (failed && stopOnError) throw firstError;
  return results;
}

module.exports = {
  pMap
};
