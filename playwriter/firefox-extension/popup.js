const $ = (id) => document.getElementById(id)
let tab
let current

function showError(error) {
  $('error').textContent = error ? String(error.message ?? error) : ''
}

function askRestart(text, automation) {
  $('main').classList.add('hidden')
  $('confirm').classList.remove('hidden')
  $('confirm-text').textContent = text
  $('confirm-yes').onclick = async () => {
    $('confirm-text').textContent = 'Restarting...'
    $('confirm-yes').disabled = true
    $('confirm-no').disabled = true
    try {
      const result = current.status ? await relay('/firefox/restart', { automation }) : await native({ type: 'restart', automation })
      if (result?.error) {
        throw new Error(result.error)
      }
    } catch (error) {
      showError(error)
      $('confirm-text').textContent = 'Restart failed.'
      $('confirm-no').disabled = false
    }
  }
}

async function render() {
  ;[tab] = await browser.tabs.query({ active: true, currentWindow: true })
  current = await tabState(tab)
  const { status, state } = current
  $('dot').classList.toggle('on', state === 'connected')
  if (!status) {
    $('status').textContent = 'Relay not running. Restart with automation starts it.'
    $('detail').textContent = ''
  } else {
    $('status').textContent = `Relay v${status.version} · ${status.browser ?? 'Browser'} automation ${status.automated ? 'on' : 'off'}`
    $('detail').textContent = `${status.sessions} session${status.sessions === 1 ? '' : 's'} · ${status.tabs} connected tab${status.tabs === 1 ? '' : 's'}`
  }
  const toggle = $('toggle')
  toggle.disabled = state === 'relay-down' || state === 'restricted'
  toggle.textContent = state === 'connected' ? 'Disconnect this tab' : state === 'restricted' ? 'Cannot attach to this page' : 'Connect this tab'
  toggle.className = state === 'connected' ? '' : 'primary'
  await paintIcon(tab, current).catch(() => {})
}

$('toggle').onclick = async () => {
  showError()
  $('toggle').disabled = true
  try {
    const disconnecting = current.state === 'connected'
    const result = await tabAction(tab.id, disconnecting ? 'disconnect' : 'connect')
    browser.runtime.sendMessage('refresh').catch(() => {})
    if (disconnecting && result.tabs === 0) {
      askRestart(`That was the last connected tab. Restart ${current.status?.browser ?? 'the browser'} normally to turn automation off? Tabs reopen.`, false)
      return
    }
  } catch (error) {
    showError(error)
  }
  await render()
}

$('restart-automation').onclick = () => askRestart('Quit and reopen with automation on? Tabs reopen.', true)
$('restart-normal').onclick = () => askRestart('Quit and reopen normally, with automation off? Tabs reopen.', false)
$('confirm-no').onclick = () => {
  $('confirm').classList.add('hidden')
  $('main').classList.remove('hidden')
  render()
}

render().catch(showError)
