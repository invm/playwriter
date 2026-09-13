import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const GECKO_EXTENSION_ID = 'playwriter-zen@invm.github.io'
const HOST_NAME = 'playwriter'

/** Shared by relay and native host, so a signed add-on can get it without the relay installing the add-on. */
export function readGeckoSecret(): string {
  const file = path.join(os.homedir(), '.playwriter', 'firefox-secret')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(file, crypto.randomUUID(), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }
  return fs.readFileSync(file, 'utf8').trim()
}

/** Writes the native messaging host manifest for this playwriter install. Returns the manifest paths. */
export function registerNativeHost(): string[] {
  const dir = path.join(os.homedir(), '.playwriter')
  const isWindows = os.platform() === 'win32'
  const launcher = path.join(dir, isWindows ? 'firefox-native-host.bat' : 'firefox-native-host')
  const command = [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url)].map((arg) => {
    return JSON.stringify(arg)
  }).join(' ')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(launcher, isWindows ? `@echo off\r\n${command} %*\r\n` : `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o755 })
  const manifest = JSON.stringify({ name: HOST_NAME, description: 'Playwriter relay helper', path: launcher, type: 'stdio', allowed_extensions: [GECKO_EXTENSION_ID] }, null, 2)
  if (isWindows) {
    const manifestPath = path.join(dir, `${HOST_NAME}.json`)
    fs.writeFileSync(manifestPath, manifest)
    execFileSync('reg', ['add', `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' })
    return [manifestPath]
  }
  const manifestDir = os.platform() === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support/Mozilla/NativeMessagingHosts')
    : path.join(os.homedir(), '.mozilla/native-messaging-hosts')
  fs.mkdirSync(manifestDir, { recursive: true })
  const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`)
  fs.writeFileSync(manifestPath, manifest)
  return [manifestPath]
}

type HostMessage = { type: 'config' } | { type: 'restart'; automation: boolean }

async function handle(message: HostMessage) {
  const { RELAY_PORT, ensureRelayServer } = await import('./relay-client.js')
  const secret = readGeckoSecret()
  if (message.type === 'config') {
    return { port: RELAY_PORT, secret }
  }
  await ensureRelayServer({ restartOnVersionMismatch: false })
  const response = await fetch(`http://127.0.0.1:${RELAY_PORT}/firefox/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-playwriter-secret': secret },
    body: JSON.stringify({ automation: message.automation }),
  })
  return response.json()
}

function runHost() {
  // stdout carries the native messaging protocol, keep logs off it.
  console.log = console.error
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32LE(0)) {
      return
    }
    const message = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString('utf8')) as HostMessage
    handle(message).catch((error: Error) => {
      return { error: error.message }
    }).then((reply) => {
      const body = Buffer.from(JSON.stringify(reply))
      const header = Buffer.alloc(4)
      header.writeUInt32LE(body.length)
      process.stdout.write(Buffer.concat([header, body]), () => {
        process.exit(0)
      })
    })
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHost()
}
