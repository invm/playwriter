# Playwriter for Zen / Firefox

Drive your real Zen or Firefox profile with Playwriter over WebDriver BiDi. Same relay, CLI, MCP, `snapshot` and labeled screenshots as the Chrome extension.

## Quick Start

```bash
playwriter session new --browser firefox        # or --browser zen
playwriter -s 1 -e 'await page.goto("https://example.com")'
playwriter -s 1 -e 'console.log(await snapshot({ page }))'
```

If the browser is already running without automation, the command stops and asks for a restart. Restart it with automation on (the window closes briefly, tabs reopen from session restore):

```bash
playwriter session new --browser firefox --restart-browser
```

### MCP

```json
{
  "mcpServers": {
    "playwriter-zen": {
      "command": "npx",
      "args": ["-y", "playwriter@latest"],
      "env": { "PLAYWRITER_BROWSER": "firefox" }
    }
  }
}
```

## Toolbar Add-on

While automation is on, the relay installs this add-on as a temporary add-on over BiDi (`webExtension.install`). It is reinstalled on every automated start and disappears when the browser restarts normally.

| Control | What it does |
|---|---|
| Connect / Disconnect | Share the current tab with agents, or take it back |
| Status | Relay version, automation on/off, sessions, connected tabs |
| Restart with automation | Quit and reopen with BiDi on (asks to confirm) |
| Restart normally | Quit and reopen without automation (asks to confirm). Offered after the last connected tab is disconnected |

| Icon | Meaning |
|---|---|
| Green + badge | Tab connected, badge = connected tabs |
| Black | Tab can be connected |
| Gray | Relay not reachable, or page can't be attached (`about:`, `moz-extension:`) |

## Architecture

```
+--------------------------+     +-------------------------+     +-----------------+
|   ZEN / FIREFOX          |     |   LOCALHOST RELAY       |     |   CLI / MCP     |
|   (your profile)         |     |   :19988                |     |                 |
|                          |     |                         |     |  +-----------+  |
|  --remote-debugging-port |     |  firefox.connectOver-   |     |  | AI Agent  |  |
|  WebDriver BiDi <-------------------> BiDi               |     |  +-----------+  |
|          | installs      | WS  |  (one session)          |     |        |        |
|          v               |     |       |                 |     |        v        |
|  +--------------------+  |     |       v                 |     |  +-----------+  |
|  | Toolbar add-on     |  |     |  tab scope:             |     |  | session / |  |
|  | connect/disconnect |--------->  /firefox/tab          |     |  | execute   |  |
|  | status  restart    |  | HTTP|  /firefox/status        |     |  +-----+-----+  |
|  +--------------------+  |     |  /firefox/restart       |     |        |        |
|                          |     |                         |     |        v        |
|  Tab 1 (connected)       |     |  /cli/* <---------------------------> HTTP      |
|  Tab 2 (agent opened)    |     |                         |     |                 |
|  Tab 3 (not connected)   |     |  Tab 3 hidden from      |     |  Playwright API |
+--------------------------+     |  context.pages()        |     +-----------------+
                                 +-------------------------+
```

1. The relay starts or attaches to the browser with `--remote-debugging-port` and reads the endpoint from `WebDriverBiDiServer.json` in the profile.
2. `firefox.connectOverBiDi` (Playwright fork) opens the single BiDi session and adopts the tabs already open.
3. The relay installs the toolbar add-on with a per-relay secret in `config.js`.
4. Clicking Connect stamps a one-time `data-playwriter-<nonce>` attribute on the tab; the relay finds the page with that attribute and marks it shared.
5. Sessions only see connected tabs plus tabs they open (`context.pages()` is filtered). The session's `page` is the connected tab, or a new agent tab.

## Parity with Chrome

Status as of the `firefox-zen-bidi` branch. ✅ same as Chrome, ⚠️ partial, ❌ missing, ❔ untested.

| Area | Chrome | Zen / Firefox |
|---|---|---|
| Protocol | CDP through `chrome.debugger` in the extension | WebDriver BiDi from the relay |
| CLI sessions, `execute`, `reset` | ✅ | ✅ |
| MCP | ✅ | ✅ `PLAYWRITER_BROWSER=firefox` |
| `snapshot`, locators, labeled screenshots, iframes, snapshot diff | ✅ | ✅ same output format |
| Playwright API (navigation, clicks, `page.route`, screenshots) | ✅ | ✅ |
| Connect / disconnect a tab from the toolbar | ✅ | ✅ |
| Agent sees only shared + agent tabs | ✅ | ⚠️ enforced by the relay, `page.context()` can reach every tab |
| Attach to the already running browser without restart | ✅ | ❌ one restart to turn automation on |
| Toolbar icon always present | ✅ Chrome Web Store | ❌ only while automation is on, needs an AMO-signed add-on |
| `getCDPSession`, raw CDP commands | ✅ | ❌ |
| `getStylesForLocator` | ✅ | ❌ |
| React component source | ✅ | ❌ |
| Debugger (breakpoints, stepping) | ✅ | ❌ |
| Editor (live edit scripts and stylesheets) | ✅ | ❌ |
| Screen recording, RTMP streaming | ✅ | ❌ |
| `playwriter recorder` (record user actions) | ✅ | ❔ |
| Multiple clients at once (external Playwright on `/cdp`) | ✅ | ❌ one BiDi session, held by the relay |
| Recovery after relay crash | ✅ automatic | ❌ browser restart |
| Remote access (`PLAYWRITER_HOST`) | ✅ | ❔ |
| Automation hidden from sites | ✅ | ❌ `navigator.webdriver` is true |
| macOS | ✅ | ✅ |
| Windows, Linux | ✅ | ❔ |

## Security

- **Local only**: BiDi listens on `127.0.0.1` with a random port; the relay on `127.0.0.1:19988`.
- **Add-on routes**: `/firefox/*` require the `x-playwriter-secret` header, a random value per relay process written into the add-on's `config.js`. Wrong or missing secret returns 403.
- **Tab scope is soft**: the relay filters pages, but `page.context()` in `execute` can still reach other tabs. Treat automation on as access to the whole browser.
- **While automation is on**, other local processes could attach over BiDi if the relay is not holding the session. Restart normally when done.

## Limitations

- The toolbar icon only exists while automation is on. Showing it in normal mode needs an AMO-signed add-on.
- If the relay crashes, the browser keeps the BiDi session locked. Run with `--restart-browser` to recover.
- The add-on reloads on each new browser connection.
- Tested on macOS (Zen, headless Firefox). Windows and Linux are not verified.

## Files

| File | Role |
|---|---|
| `playwriter/firefox-extension/manifest.json` | MV2 manifest, id `firefox@playwriter.dev` |
| `playwriter/firefox-extension/config.js` | Relay port and secret, overwritten by the relay on install |
| `playwriter/firefox-extension/shared.js` | Relay fetch, tab connect/disconnect, icon state |
| `playwriter/firefox-extension/background.js` | Refreshes icon on tab changes |
| `playwriter/firefox-extension/popup.html`, `popup.js` | Connect, status, restart UI |
| `playwriter/src/firefox-browser.ts` | Browser discovery, start/restart, add-on install, tab scope |
