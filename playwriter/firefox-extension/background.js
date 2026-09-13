let lastState = {}

async function refresh({ lookup = true } = {}) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab) {
    return
  }
  const result = await tabState(tab, { lookup })
  if (result.state === null) {
    result.state = lastState[tab.id] ?? 'idle'
  }
  lastState[tab.id] = result.state
  await paintIcon(tab, result).catch(() => {})
}

browser.tabs.onActivated.addListener(() => refresh())
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'complete' && tab.active) {
    refresh()
  }
})
browser.tabs.onRemoved.addListener((tabId) => {
  delete lastState[tabId]
})
browser.runtime.onMessage.addListener((message) => {
  if (message === 'refresh') {
    refresh()
  }
})
setInterval(() => refresh({ lookup: false }), 3000)
refresh()
