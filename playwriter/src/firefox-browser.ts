import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { getFirefox } from './playwright-import.js'
import { readGeckoSecret } from './firefox-native-host.js'

export interface GeckoInstall {
  name: 'Zen' | 'Firefox'
  executablePath: string
  profileRoot: string
}

// Linux and other unix platforms use the `??` fallbacks below.
type PerPlatform<T> = Partial<Record<NodeJS.Platform, T>>

function candidateInstalls(): GeckoInstall[] {
  const home = os.homedir()
  const env = process.env
  const platform = os.platform()
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  const onPath = (names: string[]) => {
    return (env.PATH || '').split(path.delimiter).filter(Boolean).flatMap((dir) => {
      return names.map((name) => {
        return path.join(dir, name)
      })
    })
  }
  const zenRoot = ({
    darwin: path.join(home, 'Library/Application Support/zen'),
    win32: path.join(env.APPDATA || '', 'zen'),
  } as PerPlatform<string>)[platform] ?? path.join(home, '.zen')
  const firefoxRoot = ({
    darwin: path.join(home, 'Library/Application Support/Firefox'),
    win32: path.join(env.APPDATA || '', 'Mozilla/Firefox'),
  } as PerPlatform<string>)[platform] ?? path.join(home, '.mozilla/firefox')
  const zenPaths = ({
    darwin: ['/Applications/Zen.app/Contents/MacOS/zen', path.join(home, 'Applications/Zen.app/Contents/MacOS/zen')],
    win32: [path.join(programFiles, 'Zen Browser', 'zen.exe')],
  } as PerPlatform<string[]>)[platform] ?? ['/opt/zen/zen', ...onPath(['zen-browser', 'zen'])]
  const firefoxPaths = ({
    darwin: ['/Applications/Firefox.app/Contents/MacOS/firefox', path.join(home, 'Applications/Firefox.app/Contents/MacOS/firefox')],
    win32: [path.join(programFiles, 'Mozilla Firefox', 'firefox.exe')],
  } as PerPlatform<string[]>)[platform] ?? onPath(['firefox'])

  return [
    ...zenPaths.map((executablePath) => {
      return { name: 'Zen' as const, executablePath, profileRoot: zenRoot }
    }),
    ...firefoxPaths.map((executablePath) => {
      return { name: 'Firefox' as const, executablePath, profileRoot: firefoxRoot }
    }),
  ]
}

export function findGeckoInstall(): GeckoInstall | null {
  const override = process.env.PLAYWRITER_FIREFOX_PATH
  if (override) {
    const name = /zen/i.test(override) ? 'Zen' : 'Firefox'
    const known = candidateInstalls().find((c) => {
      return c.name === name
    })!
    return { ...known, executablePath: override }
  }
  return candidateInstalls().find((c) => {
    return fs.existsSync(c.executablePath)
  }) ?? null
}

export function findDefaultProfile(install: GeckoInstall): string {
  const override = process.env.PLAYWRITER_FIREFOX_PROFILE
  if (override) {
    return path.resolve(override)
  }
  const iniPath = path.join(install.profileRoot, 'profiles.ini')
  if (!fs.existsSync(iniPath)) {
    throw new Error(`No ${install.name} profile found at ${iniPath}. Open ${install.name} once to create one.`)
  }
  const sections: Array<{ name: string; values: Record<string, string> }> = []
  for (const line of fs.readFileSync(iniPath, 'utf8').split(/\r?\n/)) {
    const header = line.match(/^\[(.+)\]$/)
    if (header) {
      sections.push({ name: header[1], values: {} })
      continue
    }
    const kv = line.match(/^([^=]+)=(.*)$/)
    if (kv && sections.length) {
      sections[sections.length - 1].values[kv[1]] = kv[2]
    }
  }
  const installDefault = sections.find((s) => {
    return s.name.startsWith('Install') && s.values.Default
  })?.values.Default
  if (installDefault) {
    return path.isAbsolute(installDefault) ? installDefault : path.join(install.profileRoot, installDefault)
  }
  const profile = sections.find((s) => {
    return s.name.startsWith('Profile') && s.values.Default === '1'
  }) ?? sections.find((s) => {
    return s.name.startsWith('Profile') && s.values.Path
  })
  if (!profile) {
    throw new Error(`No default profile in ${iniPath}`)
  }
  return profile.values.IsRelative === '0' ? profile.values.Path : path.join(install.profileRoot, profile.values.Path)
}

function runningPids({ install, profile }: { install: GeckoInstall; profile: string }): number[] {
  const exeName = path.basename(install.executablePath).toLowerCase()
  if (os.platform() === 'win32') {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    return out.split(/\r?\n/).filter((line) => {
      return line.toLowerCase().includes(exeName)
    }).map((line) => {
      return Number(line.split('","')[1])
    }).filter(Boolean)
  }
  const out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })
  const isDefaultProfile = !process.env.PLAYWRITER_FIREFOX_PROFILE
  return out.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!match) {
      return []
    }
    const command = match[2]
    const isBrowser = command.startsWith(install.executablePath) || path.basename(command.split(' ')[0]).toLowerCase() === exeName
    if (!isBrowser || command.includes('-contentproc')) {
      return []
    }
    // ps doesn't quote args and profile paths contain spaces (Application Support), so match the path text.
    const onProfile = /(^|\s)--?profile\s/.test(command) ? command.includes(` ${profile}`) : isDefaultProfile
    return onProfile ? [Number(match[1])] : []
  })
}

async function quitGracefully({ install, pids }: { install: GeckoInstall; pids: number[] }): Promise<void> {
  const platform = os.platform()
  const customProfile = !!process.env.PLAYWRITER_FIREFOX_PROFILE
  if (platform === 'darwin' && install.executablePath.includes('.app/') && !customProfile) {
    const appPath = install.executablePath.slice(0, install.executablePath.indexOf('.app/') + 4)
    execFileSync('osascript', ['-e', `quit app ${JSON.stringify(appPath)}`])
  } else if (platform === 'win32' && !customProfile) {
    try {
      execFileSync('taskkill', ['/IM', path.basename(install.executablePath)], { stdio: 'ignore' })
    } catch {}
  } else {
    for (const pid of pids) {
      process.kill(pid, 'SIGTERM')
    }
  }
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const deadline = Date.now() + 30000
  while (pids.some(isAlive)) {
    if (Date.now() > deadline) {
      throw new Error(`${install.name} did not quit within 30s (a quit confirmation may be open). Quit it manually and run the command again.`)
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
  }
}

function readBiDiEndpoint(profile: string): { url: string; mtimeMs: number } | null {
  const file = path.join(profile, 'WebDriverBiDiServer.json')
  try {
    const { ws_host, ws_port } = JSON.parse(fs.readFileSync(file, 'utf8')) as { ws_host: string; ws_port: number }
    return { url: `ws://${ws_host}:${ws_port}`, mtimeMs: fs.statSync(file).mtimeMs }
  } catch {
    return null
  }
}

const SESSION_HELD_ERROR = 'automation is held by a previous playwriter relay or another WebDriver client'
const NOT_AUTOMATED_ERROR = 'is running without automation enabled'

export function isGeckoRestartError(message: string): boolean {
  return message.includes(SESSION_HELD_ERROR) || message.includes(NOT_AUTOMATED_ERROR)
}

async function connect({ url, install }: { url: string; install: GeckoInstall }): Promise<Browser> {
  const firefox = await getFirefox()
  try {
    return await firefox.connectOverBiDi(url, { timeout: 15000 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Maximum number of active sessions')) {
      throw new Error(
        `${install.name} ${SESSION_HELD_ERROR}. Restart it to continue (tabs reopen).`,
        { cause: error },
      )
    }
    throw error
  }
}

export const geckoExtensionSecret = readGeckoSecret()
let relayPort = 19988
let installedExtensionFor: Browser | null = null

export function setGeckoRelayPort(port: number) {
  relayPort = port
}

const agentPages = new Set<Page>()
const sharedPages = new Set<Page>()

function track({ set, page }: { set: Set<Page>; page: Page }) {
  set.add(page)
  page.once('close', () => {
    set.delete(page)
  })
}

export function markAgentPage(page: Page) {
  track({ set: agentPages, page })
}

export function isAgentPage(page: Page): boolean {
  return agentPages.has(page)
}

export function isAutomatedPage(page: Page): boolean {
  return agentPages.has(page) || sharedPages.has(page)
}

export function automatedPages(): Page[] {
  return [...new Set([...sharedPages, ...agentPages])].filter((page) => {
    return !page.isClosed()
  })
}

export function sharedPage(): Page | undefined {
  return [...sharedPages].find((page) => {
    return !page.isClosed()
  })
}

/** Scopes pages() to connected + agent tabs. browser() is scoped too so
 *  context.browser().contexts()[0].pages() can't reach the user's other tabs. */
export function scopeGeckoContext(context: BrowserContext): BrowserContext {
  return new Proxy(context, {
    get(target, prop) {
      if (prop === 'pages') {
        return () => {
          return target.pages().filter(isAutomatedPage)
        }
      }
      if (prop === 'browser') {
        return () => {
          const browser = target.browser()
          return browser ? scopeGeckoBrowser(browser) : null
        }
      }
      if (prop === 'newPage') {
        return async (...args: Parameters<BrowserContext['newPage']>) => {
          const page = await target.newPage(...args)
          markAgentPage(page)
          return page
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export function scopeGeckoBrowser(browser: Browser): Browser {
  return new Proxy(browser, {
    get(target, prop) {
      if (prop === 'contexts') {
        return () => {
          return target.contexts().map(scopeGeckoContext)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function findPageByNonce({ pages, nonce }: { pages: Page[]; nonce: string }): Promise<Page | undefined> {
  const matches = await Promise.all(
    pages.map((page) => {
      const read = page.evaluate((name) => {
        return document.documentElement.hasAttribute(name)
      }, `data-playwriter-${nonce}`).catch(() => {
        return false
      })
      const timeout = new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false)
        }, 2000)
      })
      return Promise.race([read, timeout])
    }),
  )
  return pages[matches.indexOf(true)]
}

const GECKO_TAB_ACTIONS = ['lookup', 'connect', 'disconnect'] as const
export type GeckoTabAction = (typeof GECKO_TAB_ACTIONS)[number]

export function isGeckoTabAction(value: unknown): value is GeckoTabAction {
  return GECKO_TAB_ACTIONS.includes(value as GeckoTabAction)
}

export async function geckoTabAction({ nonce, action }: { nonce: string; action: GeckoTabAction }) {
  if (!/^[a-z0-9-]{8,64}$/.test(nonce)) {
    throw new Error('Invalid nonce')
  }
  const connected = await currentGeckoBrowser()
  if (action === 'lookup') {
    const page = connected ? await findPageByNonce({ pages: automatedPages(), nonce }) : undefined
    return { automated: !!page, tabs: automatedPages().length }
  }
  const { browser } = connected ?? (await getOrStartGeckoBrowser())
  const pages = action === 'connect' ? browser.contexts()[0].pages() : automatedPages()
  const page = await findPageByNonce({ pages, nonce })
  if (!page) {
    throw new Error(action === 'connect' ? 'Tab not found. Reload the tab and try again.' : 'This tab is not connected.')
  }
  if (action === 'connect') {
    track({ set: sharedPages, page })
  } else {
    sharedPages.delete(page)
    agentPages.delete(page)
  }
  return { automated: action === 'connect', tabs: automatedPages().length }
}

async function currentGeckoBrowser() {
  const result = await shared?.catch(() => {
    return null
  })
  return result?.browser.isConnected() ? result : null
}

export async function geckoStatus() {
  const install = findGeckoInstall()
  const connected = await currentGeckoBrowser()
  return { browser: install?.name ?? null, automated: !!connected, tabs: connected ? automatedPages().length : 0 }
}

export async function restartGeckoBrowser({ automation }: { automation: boolean }) {
  const install = findGeckoInstall()
  if (!install) {
    throw new Error('Zen or Firefox not found.')
  }
  const profile = findDefaultProfile(install)
  await disconnectGeckoBrowser()
  const pids = runningPids({ install, profile })
  if (pids.length) {
    await quitGracefully({ install, pids })
  }
  if (automation) {
    await getOrStartGeckoBrowser()
    return
  }
  spawn(install.executablePath, ['--profile', profile], { detached: true, stdio: 'ignore' }).unref()
}

async function installExtension(browser: Browser) {
  if (installedExtensionFor === browser) {
    return
  }
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'firefox-extension')
  const target = path.join(os.homedir(), '.playwriter', `firefox-extension-${relayPort}`)
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(source, target, { recursive: true })
  fs.writeFileSync(path.join(target, 'config.js'), `globalThis.PLAYWRITER = ${JSON.stringify({ port: relayPort, secret: geckoExtensionSecret })}\n`)
  const connection = (browser as unknown as { _connection: { toImpl?: (object: unknown) => { _browserSession: { send(method: string, params: object): Promise<unknown> } } } })._connection
  const impl = connection.toImpl?.(browser)
  if (!impl) {
    return
  }
  await impl._browserSession.send('webExtension.install', { extensionData: { type: 'path', path: target } })
  installedExtensionFor = browser
}

async function withAutomatedPages(result: { browser: Browser; install: GeckoInstall }) {
  const context = result.browser.contexts()[0]
  context.on('page', async (page) => {
    const opener = await page.opener().catch(() => {
      return null
    })
    if (opener && isAutomatedPage(opener)) {
      markAgentPage(page)
    }
  })
  await installExtension(result.browser).catch(() => {})
  return result
}

async function startAndConnect({ restart }: { restart: boolean }): Promise<{ browser: Browser; install: GeckoInstall }> {
  const install = findGeckoInstall()
  if (!install) {
    throw new Error('Zen or Firefox not found. Install one, or set PLAYWRITER_FIREFOX_PATH to the browser executable.')
  }
  const profile = findDefaultProfile(install)

  const existing = readBiDiEndpoint(profile)
  if (existing) {
    const browser = await connect({ url: existing.url, install }).catch((error: Error) => {
      if (error.message.includes(SESSION_HELD_ERROR) && !restart) {
        throw error
      }
      return null
    })
    if (browser) {
      return { browser, install }
    }
  }

  const pids = runningPids({ install, profile })
  if (pids.length && !restart) {
    throw new Error(`${install.name} ${NOT_AUTOMATED_ERROR}. Restart it to continue (tabs reopen).`)
  }
  if (pids.length) {
    await quitGracefully({ install, pids })
  }

  const startedAt = Date.now()
  const child = spawn(install.executablePath, ['--remote-debugging-port=0', '--profile', profile], {
    detached: true,
    stdio: 'ignore',
  })
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  child.unref()

  while (Date.now() - startedAt < 30000) {
    const endpoint = readBiDiEndpoint(profile)
    if (endpoint && endpoint.mtimeMs >= startedAt - 1000) {
      return { browser: await connect({ url: endpoint.url, install }), install }
    }
    if (exited && Date.now() - startedAt > 5000) {
      break
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250)
    })
  }
  throw new Error(`${install.name} did not enable automation within 30s. Quit ${install.name} and retry.`)
}

let shared: Promise<{ browser: Browser; install: GeckoInstall }> | null = null

export async function getOrStartGeckoBrowser({ restart = false }: { restart?: boolean } = {}): Promise<{ browser: Browser; install: GeckoInstall }> {
  const current = shared
  if (current) {
    const result = await current.catch(() => {
      return null
    })
    if (result?.browser.isConnected()) {
      return result
    }
    if (shared === current) {
      shared = null
    }
  }
  if (!shared) {
    const promise = startAndConnect({ restart }).then(withAutomatedPages)
    shared = promise
    promise.catch(() => {
      if (shared === promise) {
        shared = null
      }
    })
  }
  return shared
}

let attaching = false

export async function attachRunningGeckoBrowser(): Promise<void> {
  if (attaching || (await currentGeckoBrowser())) {
    return
  }
  attaching = true
  try {
    const install = findGeckoInstall()
    const endpoint = install && readBiDiEndpoint(findDefaultProfile(install))
    if (!install || !endpoint) {
      return
    }
    const promise = connect({ url: endpoint.url, install }).then((browser) => {
      return withAutomatedPages({ browser, install })
    })
    shared = promise
    promise.catch(() => {
      if (shared === promise) {
        shared = null
      }
    })
    await promise
  } catch {
  } finally {
    attaching = false
  }
}

let closing: Promise<void> = Promise.resolve()

/** Relay close and process shutdown both call this; every caller awaits the same in-flight close. */
export function disconnectGeckoBrowser(): Promise<void> {
  const current = shared
  shared = null
  agentPages.clear()
  sharedPages.clear()
  const close = current?.then((result) => {
    return result.browser.close()
  }).catch(() => {})
  closing = Promise.all([closing, close]).then(() => {})
  return closing
}
