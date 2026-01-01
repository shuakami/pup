'use strict';

const { formatText } = require('./format-text');

/**
 * Output policy:
 * - --json / -j: compact JSONL (for programmatic use)
 * - --pretty: JSON pretty printed
 * - default: colorful text format (Vite/Vitest style)
 */
function makeWriter(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const JSON_LINE = args.includes('--json') || args.includes('-j');
  const PRETTY_JSON = args.includes('--pretty');

  return (obj, startTime) => {
    // 检查并显示标签页内存警告
    if (obj && obj._tabWarning) {
      process.stdout.write(`${obj._tabWarning}\n`);
      delete obj._tabWarning;
    }
    
    if (JSON_LINE) {
      process.stdout.write(`${JSON.stringify(obj)}\n`);
    } else if (PRETTY_JSON) {
      process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatText(obj, startTime)}\n`);
    }
  };
}

module.exports = { makeWriter };
