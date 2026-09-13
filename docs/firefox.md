# Playwriter for Zen / Firefox

Drive your real Zen or Firefox profile with Playwriter over WebDriver BiDi. Same relay, CLI, MCP, `snapshot` and labeled screenshots as the Chrome extension.

## Quick Start

```bash
playwriter session new --browser firefox        # or --browser zen
playwriter -s 1 -e 'await page.goto("https://example.com")'
playwriter -s 1 -e 'console.log(await snapshot({ page }))'
```

With the permanent add-on installed (below), no terminal is needed: click the toolbar icon, Restart with automation, Connect this tab.

From the CLI, if the browser is already running without automation, the command stops and asks for a restart. Restart it with automation on (the window closes briefly, tabs reopen from session restore):

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

Two ways to get it:

- **Permanent (recommended)**: install the Mozilla-signed unlisted `.xpi` (`web-ext sign --channel unlisted`, then `about:addons` → Install Add-on From File), and register the helper once with `playwriter firefox install-helper`. The icon is always present, also when automation is off.
- **Temporary**: while automation is on, the relay installs the add-on over BiDi (`webExtension.install`). It disappears when the browser restarts normally.

The helper is a native messaging host (`~/.playwriter/firefox-native-host`, manifest in `~/Library/Application Support/Mozilla/NativeMessagingHosts/playwriter.json` on macOS, `~/.mozilla/native-messaging-hosts` on Linux, `HKCU\Software\Mozilla\NativeMessagingHosts` on Windows). It gives the add-on the relay port and secret, and handles Restart when the relay is down: starts the relay, which quits the browser and reopens it with automation. The relay then attaches on its own (polls every 5s).

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
|                          | WS  |  (one session, auto-    |     |        |        |
|                          |     |   attach every 5s)      |     |        v        |
|  +--------------------+  |     |       |                 |     |  +-----------+  |
|  | Toolbar add-on     |  |     |       v                 |     |  | session / |  |
|  | (signed, permanent)|  |     |  tab scope:             |     |  | execute   |  |
|  | connect/disconnect |--------->  /firefox/tab          |     |  +-----+-----+  |
|  | status  restart    |  | HTTP|  /firefox/status        |     |        |        |
|  +--------------------+  |     |  /firefox/restart       |     |        v        |
|     | native messaging   |     |       ^                 |     |       HTTP      |
|     v                    |     |       |                 |     |        |        |
|  +--------------------+  |     |  /cli/* <------------------------------+        |
|  | Helper (Node)      |---------> starts relay,          |     |                 |
|  | port, secret,      |  |     |   restart               |     |  Playwright API |
|  | restart            |  |     |                         |     |                 |
|  +--------------------+  |     |  Tab 3 hidden from      |     |                 |
|                          |     |  context.pages()        |     |                 |
|  Tab 1 (connected)       |     |                         |     |                 |
|  Tab 2 (agent opened)    |     |                         |     |                 |
|  Tab 3 (not connected)   |     |                         |     |                 |
+--------------------------+     +-------------------------+     +-----------------+
```

1. Restart with automation (popup, via the relay or the helper, or `--restart-browser`) relaunches the browser with `--remote-debugging-port`. The relay reads the endpoint from `WebDriverBiDiServer.json` in the profile.
2. `firefox.connectOverBiDi` (Playwright fork) opens the single BiDi session and adopts the tabs already open. The relay attaches on its own when that file appears.
3. The add-on authenticates with the secret from `~/.playwriter/firefox-secret`, read through the helper (permanent add-on) or written into `config.js` (temporary add-on).
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
| Attach to the already running browser without restart | ✅ | ⚠️ one click, Restart with automation (tabs reopen) |
| Toolbar icon always present | ✅ Chrome Web Store | ✅ signed unlisted add-on + helper |
| `getCDPSession`, raw CDP commands | ✅ | ❌ |
| `getStylesForLocator` | ✅ | ❌ |
| React component source | ✅ | ❌ |
| Debugger (breakpoints, stepping) | ✅ | ❌ |
| Editor (live edit scripts and stylesheets) | ✅ | ❌ |
| Screen recording, RTMP streaming | ✅ | ❌ |
| `playwriter recorder` (record user actions) | ✅ | ❔ |
| Multiple clients at once (external Playwright on `/cdp`) | ✅ | ❌ one BiDi session, held by the relay |
| Recovery after relay crash | ✅ automatic | ⚠️ clean relay restarts release the session, a crash needs a browser restart |
| Remote access (`PLAYWRITER_HOST`) | ✅ | ❔ |
| Automation hidden from sites | ✅ | ❌ `navigator.webdriver` is true |
| macOS | ✅ | ✅ |
| Windows, Linux | ✅ | ❔ |

## Security

- **Local only**: BiDi listens on `127.0.0.1` with a random port; the relay on `127.0.0.1:19988`.
- **Add-on routes**: `/firefox/*` require the `x-playwriter-secret` header, a random value stored in `~/.playwriter/firefox-secret` (mode 600). Wrong or missing secret returns 403.
- **Helper**: only the add-on id `playwriter-zen@invm.github.io` may start it (`allowed_extensions`). It runs as your user and can start the relay and restart the browser.
- **Tab scope is soft**: the relay filters pages, but `page.context()` in `execute` can still reach other tabs. Treat automation on as access to the whole browser.
- **While automation is on**, other local processes could attach over BiDi if the relay is not holding the session. Restart normally when done.

## Limitations

- Without the signed add-on, the toolbar icon only exists while automation is on.
- If the relay crashes (killed without shutdown), the browser keeps the BiDi session locked. Restart the browser to recover.
- The add-on reloads on each new browser connection.
- Tested on macOS (Zen, headless Firefox). Windows and Linux are not verified.

## Files

| File | Role |
|---|---|
| `playwriter/firefox-extension/manifest.json` | MV2 manifest, id `playwriter-zen@invm.github.io` |
| `playwriter/firefox-extension/config.js` | Relay port and secret, empty in the signed build, filled by the relay for the temporary install |
| `playwriter/firefox-extension/shared.js` | Relay fetch (secret from helper when missing), tab connect/disconnect, icon state |
| `playwriter/firefox-extension/background.js` | Refreshes icon on tab changes |
| `playwriter/firefox-extension/popup.html`, `popup.js` | Connect, status, restart UI |
| `playwriter/src/firefox-browser.ts` | Browser discovery, start/restart, add-on install, tab scope |
| `playwriter/src/firefox-native-host.ts` | Helper: shared secret, native messaging host, `firefox install-helper` registration |
