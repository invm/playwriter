import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { firefox, type Browser } from '@xmorse/playwright-core'

export interface GeckoInstall {
  name: 'Zen' | 'Firefox'
  executablePath: string
  profileRoot: string
}

type Platform = 'darwin' | 'win32'

function candidateInstalls(): GeckoInstall[] {
  const home = os.homedir()
  const env = process.env
  const platform = os.platform() as Platform
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  const onPath = (names: string[]) => {
    return (env.PATH || '').split(path.delimiter).filter(Boolean).flatMap((dir) => {
      return names.map((name) => path.join(dir, name))
    })
  }
  const zenRoot = {
    darwin: path.join(home, 'Library/Application Support/zen'),
    win32: path.join(env.APPDATA || '', 'zen'),
  }[platform] ?? path.join(home, '.zen')
  const firefoxRoot = {
    darwin: path.join(home, 'Library/Application Support/Firefox'),
    win32: path.join(env.APPDATA || '', 'Mozilla/Firefox'),
  }[platform] ?? path.join(home, '.mozilla/firefox')
  const zenPaths = {
    darwin: ['/Applications/Zen.app/Contents/MacOS/zen', path.join(home, 'Applications/Zen.app/Contents/MacOS/zen')],
    win32: [path.join(programFiles, 'Zen Browser', 'zen.exe')],
  }[platform] ?? ['/opt/zen/zen', ...onPath(['zen-browser', 'zen'])]
  const firefoxPaths = {
    darwin: ['/Applications/Firefox.app/Contents/MacOS/firefox', path.join(home, 'Applications/Firefox.app/Contents/MacOS/firefox')],
    win32: [path.join(programFiles, 'Mozilla Firefox', 'firefox.exe')],
  }[platform] ?? onPath(['firefox'])

  return [
    ...zenPaths.map((executablePath) => ({ name: 'Zen' as const, executablePath, profileRoot: zenRoot })),
    ...firefoxPaths.map((executablePath) => ({ name: 'Firefox' as const, executablePath, profileRoot: firefoxRoot })),
  ]
}

export function findGeckoInstall(): GeckoInstall | null {
  const override = process.env.PLAYWRITER_FIREFOX_PATH
  if (override) {
    const name = /zen/i.test(override) ? 'Zen' : 'Firefox'
    const known = candidateInstalls().find((c) => c.name === name)!
    return { ...known, executablePath: override }
  }
  return candidateInstalls().find((c) => fs.existsSync(c.executablePath)) ?? null
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
  const installDefault = sections.find((s) => s.name.startsWith('Install') && s.values.Default)?.values.Default
  if (installDefault) {
    return path.isAbsolute(installDefault) ? installDefault : path.join(install.profileRoot, installDefault)
  }
  const profile = sections.find((s) => s.name.startsWith('Profile') && s.values.Default === '1')
    ?? sections.find((s) => s.name.startsWith('Profile') && s.values.Path)
  if (!profile) {
    throw new Error(`No default profile in ${iniPath}`)
  }
  return profile.values.IsRelative === '0' ? profile.values.Path : path.join(install.profileRoot, profile.values.Path)
}

function runningPids({ install, profile }: { install: GeckoInstall; profile: string }): number[] {
  const exeName = path.basename(install.executablePath).toLowerCase()
  if (os.platform() === 'win32') {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    return out.split(/\r?\n/).filter((line) => line.toLowerCase().includes(exeName)).map((line) => Number(line.split('","')[1])).filter(Boolean)
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
    const profileArg = command.match(/--?profile\s+(\S+)/)
    const onProfile = profileArg ? path.resolve(profileArg[1]) === profile : isDefaultProfile
    return onProfile ? [Number(match[1])] : []
  })
}

async function quitGracefully({ install, pids }: { install: GeckoInstall; pids: number[] }): Promise<void> {
  const platform = os.platform()
  if (platform === 'darwin' && install.executablePath.includes('.app/')) {
    const appPath = install.executablePath.slice(0, install.executablePath.indexOf('.app/') + 4)
    execFileSync('osascript', ['-e', `quit app ${JSON.stringify(appPath)}`])
  } else if (platform === 'win32') {
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
    await new Promise((resolve) => setTimeout(resolve, 200))
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

async function connect(url: string, install: GeckoInstall): Promise<Browser> {
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

async function startAndConnect({ restart }: { restart: boolean }): Promise<{ browser: Browser; install: GeckoInstall }> {
  const install = findGeckoInstall()
  if (!install) {
    throw new Error('Zen or Firefox not found. Install one, or set PLAYWRITER_FIREFOX_PATH to the browser executable.')
  }
  const profile = findDefaultProfile(install)

  const existing = readBiDiEndpoint(profile)
  if (existing) {
    const browser = await connect(existing.url, install).catch((error: Error) => {
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
      return { browser: await connect(endpoint.url, install), install }
    }
    if (exited && Date.now() - startedAt > 5000) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${install.name} did not enable automation within 30s. Quit ${install.name} and retry.`)
}

let shared: Promise<{ browser: Browser; install: GeckoInstall }> | null = null

export async function getOrStartGeckoBrowser({ restart = false }: { restart?: boolean } = {}): Promise<{ browser: Browser; install: GeckoInstall }> {
  const current = shared
  if (current) {
    const result = await current.catch(() => null)
    if (result?.browser.isConnected()) {
      return result
    }
    if (shared === current) {
      shared = null
    }
  }
  if (!shared) {
    const promise = startAndConnect({ restart })
    shared = promise
    promise.catch(() => {
      if (shared === promise) {
        shared = null
      }
    })
  }
  return shared
}

export async function disconnectGeckoBrowser(): Promise<void> {
  const current = shared
  shared = null
  const result = await current?.catch(() => null)
  await result?.browser.close().catch(() => {})
}
