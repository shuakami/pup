'use strict';

function serializeError(err) {
  const message = (err && err.message) ? String(err.message) : String(err || 'Unknown error');
  const name = (err && err.name) ? String(err.name) : 'Error';
  const code = (err && err.code) ? String(err.code) : undefined;
  const out = { name, message };
  if (code) out.code = code;
  return out;
}

function pickCorrelation(req) {
  const keys = ['rpcId', 'reqId', 'requestId', 'corrId', 'correlationId', 'seq'];
  for (const k of keys) {
    if (req && Object.prototype.hasOwnProperty.call(req, k)) return req[k];
  }
  return null;
}

module.exports = {
  serializeError,
  pickCorrelation
};
