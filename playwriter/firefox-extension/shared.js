let config = globalThis.PLAYWRITER

function native(message) {
  return browser.runtime.sendNativeMessage('playwriter', message)
}

async function relay(path, body) {
  if (!config.secret) {
    config = await native({ type: 'config' }).catch(() => config)
  }
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-playwriter-secret': config.secret },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await response.json()
  if (json.error) {
    throw new Error(json.error)
  }
  return json
}

async function tabAction(tabId, action) {
  const nonce = crypto.randomUUID()
  const name = JSON.stringify(`data-playwriter-${nonce}`)
  await browser.tabs.executeScript(tabId, { code: `document.documentElement.setAttribute(${name}, '')` })
  try {
    return await relay('/firefox/tab', { nonce, action })
  } finally {
    await browser.tabs.executeScript(tabId, { code: `document.documentElement.removeAttribute(${name})` }).catch(() => {})
  }
}

const ICONS = {
  gray: { 16: 'icons/icon-gray-16.png', 32: 'icons/icon-gray-32.png' },
  green: { 16: 'icons/icon-green-16.png', 32: 'icons/icon-green-32.png' },
  black: { 16: 'icons/icon-black-16.png', 32: 'icons/icon-black-32.png' },
}

async function tabState(tab, { lookup = true } = {}) {
  const status = await relay('/firefox/status').catch(() => null)
  if (!status) {
    return { status, state: 'relay-down' }
  }
  if (!tab?.id || !/^(https?|file):/.test(tab.url ?? '')) {
    return { status, state: 'restricted' }
  }
  if (!status.automated) {
    return { status, state: 'idle' }
  }
  if (!lookup) {
    return { status, state: null }
  }
  const result = await tabAction(tab.id, 'lookup').catch(() => null)
  if (!result) {
    return { status, state: 'restricted' }
  }
  return { status: { ...status, tabs: result.tabs }, state: result.automated ? 'connected' : 'idle' }
}

async function paintIcon(tab, { status, state }) {
  const look = {
    'relay-down': ['gray', '...', 'Waiting for playwriter relay...'],
    restricted: ['gray', null, 'Cannot attach to this page'],
    connected: ['green', null, 'Connected - Click to manage'],
    idle: ['black', null, 'Click to connect this tab'],
  }[state]
  const badge = look[1] ?? (status?.tabs ? String(status.tabs) : '')
  await browser.browserAction.setIcon({ tabId: tab.id, path: ICONS[look[0]] })
  await browser.browserAction.setTitle({ tabId: tab.id, title: `${look[2]}\nAutomation stays on until the last tab is disconnected.` })
  await browser.browserAction.setBadgeText({ text: badge })
  await browser.browserAction.setBadgeBackgroundColor({ color: state === 'connected' ? '#22c55e' : '#6b7280' })
}
