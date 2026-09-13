---
'@xmorse/playwright-core': minor
'playwriter': minor
---

Drive Zen and Firefox with your own profile, no extension.

```bash
playwriter session new --browser firefox
playwriter -s 1 -e "console.log(await snapshot({ page }))"
```

Playwriter finds Zen or Firefox and its default profile, then opens the browser with WebDriver BiDi enabled. If automation is already on, it attaches. If the browser is open without automation, the command offers to restart it, and `--restart-browser` does it without asking. The browser quits gracefully, so tabs reopen. Each session works in its own tab, and your other tabs and logins stay as they are. Deleting the last session ends the automation session and leaves the browser open.

`snapshot()` and `screenshotWithAccessibilityLabels()` return the same locators and labels as in Chrome. For the MCP, set `PLAYWRITER_BROWSER=firefox` in the client config.

`@xmorse/playwright-core` adds `firefox.connectOverBiDi(wsEndpoint)`, the BiDi counterpart of `chromium.connectOverCDP`. Tabs that are already open show up as pages of the default context, and closing the returned browser leaves the browser running. Page creation also falls back to tabs on Gecko builds that reject new windows, such as Zen.
