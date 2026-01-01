# pup

Browser automation for AI agents.

![demo](demo.gif)

```bash
pup goto https://google.com
pup scan
pup click 3
pup type 2 "hello world" --enter
```

## What is this

LLMs can't see what's inside a browser. pup connects to Chrome via DevTools Protocol, scans page elements into structured data, and lets agents understand and interact with pages.

- **AXTree scanning** - Get page elements via accessibility tree, semantic detection of buttons/links/inputs without CSS selectors
- **Agent-first** - All commands support JSON output, works with pipes and stdin
- **Stealth mode** - Integrated puppeteer-extra-stealth, bypasses most anti-bot detection
- **DevTools access** - Full CDP capabilities: network capture, script debugging, cookie/storage management
- **Performance profiling** - Core Web Vitals, CPU profiling, memory analysis, network waterfall
- **Plugin architecture** - Modular, load on demand

## Install

```bash
npm install -g @sdjz/pup
```

## Quick Start

```bash
# Open a page
pup goto https://example.com

# Scan page elements
pup scan --no-empty

# Interact by element ID
pup click 5
pup type 3 "search" --enter

# JSON output for programs
pup scan --json
```

## Commands

### Navigation

```bash
goto <url>              # Open URL
back / forward          # History navigation
reload                  # Reload page
scroll <up|down|top|bottom>  # Scroll
wait <ms>               # Wait milliseconds
```

### Element Interaction

```bash
scan                    # Scan elements, get IDs
scanall                 # Scan entire page (scrolls)
find <text>             # Find elements by text
click <id>              # Click element
click <id> --js         # JS click (for modals)
type <id> <text>        # Type text
type <id> <text> --enter --clear  # Clear, type, enter
hover <id>              # Mouse hover
select <id> <option>    # Select dropdown
```

### Tab Management

```bash
tabs                    # List all tabs
tab <id>                # Switch to tab
newtab [url]            # Open new tab
close                   # Close current tab
closetab <id>           # Close specific tab
```

### DevTools

```bash
network                 # View requests
network --capture       # Enable XHR capture
network --xhr           # View captured XHR
cookies                 # View cookies
cookies --set name=val  # Set cookie
storage                 # View localStorage
storage --session       # View sessionStorage
scripts                 # List page scripts
scripts --search <q>    # Search in scripts
var <path>              # Read global variable
exec <js>               # Execute JavaScript
hook <func> <code>      # Hook function
cdp <method> [params]   # Raw CDP command
dom <selector>          # Query DOM
```

### Performance Profiling

```bash
perf                    # Quick overview (Web Vitals)
perf --reload           # Fresh page metrics
perf-load [url]         # Full page load analysis
perf-js                 # JavaScript CPU profiling
perf-memory             # Memory & DOM analysis
perf-network            # Network waterfall
perf-longtasks          # Main thread blocking
perf-trace              # Full timeline trace
perf-analyze            # AI-grade detailed analysis
```

### File Transfer

```bash
upload <file>           # Upload to file input
download <url>          # Download file
download links          # List downloadable links
screenshot [file]       # Take screenshot
```

### Other

```bash
emulate <device>        # iphone/ipad/android
emulate viewport 1920x1080
ipinfo                  # IP and location info
status                  # Current page info
ping                    # Connection test
```

Full help: `pup help`  
Command details: `pup help <command>`

## Agent Integration

pup output is designed for LLMs - structured text that's easy to read:

```bash
$ pup scan --no-empty --limit 5
[+] SCAN 150ms
    title Google
    url https://www.google.com/
    ◆ 5 elements in 874x560

    [  1] link     "Gmail"
    [  2] combobox "Search"
    [  3] button   "Google Search"
    [  4] button   "I'm Feeling Lucky"
    [  5] link     "About"
```

LLMs read this output directly, understand the page, and decide what to do next.

### Typical Workflow

```
1. pup goto https://example.com    # Open page
2. pup scan --no-empty             # Scan elements
3. LLM decides: click element 5
4. pup click 5                     # Execute
5. pup scan --no-empty             # Check result
6. ...loop
```

### Batch Mode

```bash
pup batch "goto https://example.com ; scan --no-empty ; click 3"
```

### JSON Mode

```bash
pup scan --json
# {"ok":true,"cmd":"SCAN","elements":[...]}
```

### REPL Mode

```bash
pup --json
{"cmd":"GOTO","url":"https://example.com"}
{"cmd":"SCAN"}
```
