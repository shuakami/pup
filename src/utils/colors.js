'use strict';

/**
 * SOTA Terminal Colors - Vite/Vitest inspired
 * Minimal, elegant, fast
 */

// Check if colors are supported
const isColorSupported = 
  process.env.FORCE_COLOR !== '0' &&
  (process.env.FORCE_COLOR || 
   process.env.COLORTERM === 'truecolor' ||
   process.stdout.isTTY);

// ANSI escape codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// Vite/Vitest color palette
const colors = {
  // Core colors
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  
  // Bright variants
  brightCyan: '\x1b[96m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightRed: '\x1b[91m',
  brightMagenta: '\x1b[95m',
  brightBlue: '\x1b[94m',
};

// Color functions
const c = (color, text) => isColorSupported ? `${color}${text}${RESET}` : text;
const bold = (text) => isColorSupported ? `${BOLD}${text}${RESET}` : text;
const dim = (text) => isColorSupported ? `${DIM}${text}${RESET}` : text;

// Semantic colors (Vite style)
const cyan = (t) => c(colors.cyan, t);
const green = (t) => c(colors.green, t);
const yellow = (t) => c(colors.yellow, t);
const red = (t) => c(colors.red, t);
const magenta = (t) => c(colors.magenta, t);
const blue = (t) => c(colors.blue, t);
const gray = (t) => c(colors.gray, t);
const white = (t) => c(colors.white, t);

// Bright variants
const brightCyan = (t) => c(colors.brightCyan, t);
const brightGreen = (t) => c(colors.brightGreen, t);
const brightYellow = (t) => c(colors.brightYellow, t);
const brightRed = (t) => c(colors.brightRed, t);

// Icons (minimal ASCII style, keep ◆ for brand)
const icons = {
  success: green('+'),
  error: red('-'),
  warn: yellow('!'),
  info: cyan('*'),
  arrow: cyan('>'),
  dot: gray('·'),
  bullet: gray('-'),
  link: blue('>'),
  tab: magenta('◆'),
  scan: cyan('◆'),
  click: green('+'),
  type: yellow('+'),
  scroll: blue('>'),
  wait: gray('...'),
};

// Spinner frames (minimal ASCII)
const spinnerFrames = ['-', '\\', '|', '/'];

class Spinner {
  constructor(text = '') {
    this.text = text;
    this.frame = 0;
    this.interval = null;
    this.stream = process.stderr;
  }

  start(text) {
    if (text) this.text = text;
    if (!isColorSupported || !this.stream.isTTY) {
      this.stream.write(`${gray('...')} ${this.text}\n`);
      return this;
    }
    
    this.interval = setInterval(() => {
      const frame = cyan(spinnerFrames[this.frame]);
      this.stream.write(`\r${frame} ${this.text}`);
      this.frame = (this.frame + 1) % spinnerFrames.length;
    }, 80);
    
    return this;
  }

  stop(finalText) {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (isColorSupported && this.stream.isTTY) {
      this.stream.write('\r\x1b[K'); // Clear line
    }
    if (finalText) {
      this.stream.write(`${finalText}\n`);
    }
    return this;
  }

  success(text) {
    return this.stop(`${icons.success} ${text || this.text}`);
  }

  error(text) {
    return this.stop(`${icons.error} ${red(text || this.text)}`);
  }
}

// Progress bar (minimal)
function progressBar(current, total, width = 20) {
  const percent = Math.min(1, current / total);
  const filled = Math.round(width * percent);
  const empty = width - filled;
  const bar = cyan('█'.repeat(filled)) + gray('░'.repeat(empty));
  return `${bar} ${gray(`${current}/${total}`)}`;
}

// Format duration (Vite style)
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}m`;
}

// Box drawing (minimal)
function box(title, content) {
  const lines = [];
  lines.push(`${cyan('┌')} ${bold(title)}`);
  if (content) {
    const contentLines = content.split('\n');
    for (const line of contentLines) {
      lines.push(`${cyan('│')} ${line}`);
    }
  }
  lines.push(cyan('└'));
  return lines.join('\n');
}

module.exports = {
  isColorSupported,
  // Basic colors
  cyan, green, yellow, red, magenta, blue, gray, white,
  brightCyan, brightGreen, brightYellow, brightRed,
  bold, dim,
  // Icons
  icons,
  // Utilities
  Spinner,
  progressBar,
  formatDuration,
  box,
};
