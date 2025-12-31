'use strict';

/**
 * @param {any} x
 * @returns {string}
 */
function toStr(x) {
  if (x === null || x === undefined) return '';
  return String(x);
}

module.exports = {
  toStr
};
