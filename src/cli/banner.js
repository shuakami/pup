'use strict';

const path = require('path');
const { brightCyan, bold, gray } = require('../utils/colors');

function getVersion() {
  // Best effort: resolve package.json relative to src/
  try {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    if (pkg && pkg.version) return String(pkg.version);
  } catch {}
  return '0.0.0';
}

// Banner (minimal, Vite-style)
function printBanner() {
  const version = getVersion();
  console.log('');
  console.log(`  ${bold(brightCyan('◆'))} ${bold('Pup')} ${gray('v' + version)}`);
  console.log('');
}

module.exports = {
  printBanner,
  getVersion
};
