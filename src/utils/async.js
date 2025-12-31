'use strict';

/**
 * Sleep for ms.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  const t = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, t));
}

/**
 * Wrap a promise with a timeout (rejects on timeout).
 * Note: cannot cancel the underlying promise; callers should treat timeouts as "hung".
 * @template T
 * @param {Promise<T>} p
 * @param {number} timeoutMs
 * @param {string} [message]
 * @returns {Promise<T>}
 */
function withTimeout(p, timeoutMs, message = 'timeout') {
  const t = Math.max(0, Number(timeoutMs) || 0);
  if (!t) return p;

  /** @type {any} */
  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(String(message || 'timeout'));
      err.code = 'ETIMEDOUT';
      reject(err);
    }, t);
  });

  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeoutPromise
  ]);
}

/**
 * Wait for an EventBus event once with timeout.
 * @param {{once:(event:string, fn:(payload:any)=>void)=>any, off?:(event:string,fn:(payload:any)=>void)=>any}} bus
 * @param {string} event
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function waitForEvent(bus, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = Math.max(0, Number(timeoutMs) || 0);

    const onEvt = (payload) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(payload);
    };

    const cleanup = () => {
      try {
        if (typeof bus.off === 'function') bus.off(event, onEvt);
      } catch {}
      try {
        if (timer) clearTimeout(timer);
      } catch {}
    };

    let timer = null;
    if (t) {
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        const err = new Error(`waitForEvent timeout: ${String(event)}`);
        err.code = 'ETIMEDOUT';
        reject(err);
      }, t);
    }

    try {
      if (typeof bus.once === 'function') bus.once(event, onEvt);
      else throw new Error('bus has no once');
    } catch (e) {
      cleanup();
      reject(e);
    }
  });
}

module.exports = {
  sleep,
  withTimeout,
  waitForEvent
};
