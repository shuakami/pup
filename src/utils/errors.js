'use strict';

/**
 * Heuristic: identify errors that are likely caused by a closed page/session/browser
 * and can be recovered by reacquiring the page/CDP session.
 * @param {any} err
 * @returns {boolean}
 */
function isRetryableError(err) {
  const msg = (err && err.message) ? String(err.message) : String(err || '');
  const needles = [
    'Target closed',
    'Session closed',
    'Execution context was destroyed',
    'Cannot find context with specified id',
    'Protocol error',
    'WebSocket is not open',
    'Navigation failed because browser has disconnected',
    'Browser is disconnected',
    'Most likely the page has been closed',
    'Connection closed',
    'disconnected',
    'closed'
  ];
  return needles.some((n) => msg.includes(n));
}

/**
 * Check if error is a circuit breaker error
 * @param {any} err
 * @returns {boolean}
 */
function isCircuitBreakerError(err) {
  const code = err && err.code;
  return code === 'CDP_BREAKER_OPEN';
}

module.exports = {
  isRetryableError,
  isCircuitBreakerError
};
