import { chmodSync, existsSync, statSync } from 'fs'
import { createRequire } from 'module'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { ipcMain, type WebContents } from 'electron'
import * as pty from 'node-pty'
import { Terminal as ScreenTerminal } from '@xterm/headless'
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalOutputChunk,
  TerminalReadResult,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
  TerminalWriteSource,
} from '../shared/types'
import { mainLog } from './logger'

const TERMINAL_DATA_CHANNEL = 'terminal:data'
const TERMINAL_EXIT_CHANNEL = 'terminal:exit'
const MAX_BUFFER_CHARS = 240_000
const DEFAULT_COLS = 100
const DEFAULT_ROWS = 30
const requireForNodePty = createRequire(__filename)
let nodePtyHelperPermissionsChecked = false

interface TerminalSessionRecord {
  sessionId: string
  cwd: string
  shell: string
  shellLabel: string
  pid: number
  pty: pty.IPty
  screen: ScreenTerminal
  screenWriteReady: Promise<void>
  cols: number
  rows: number
  status: TerminalSessionStatus
  startedAt: number
  exitedAt?: number
  exitCode?: number
  signal?: number
  exitNotified?: boolean
  nextSeq: number
  chunks: TerminalOutputChunk[]
  bufferChars: number
  clients: Map<number, WebContents>
}

interface AttachInput {
  sessionId: string
  cwd?: string
  cols?: number
  rows?: number
}

function sanitizeEnv(sessionId: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) env[key] = value
  }

  delete env.NO_COLOR
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Craft Agents'
  env.FORCE_COLOR = '1'
  env.CLICOLOR = '1'
  env.CLICOLOR_FORCE = '1'
  env.LSCOLORS = 'ExFxBxDxCxegedabagacad'
  env.CRAFT_SHARED_TERMINAL = '1'
  env.CRAFT_AGENT_SESSION_ID = sessionId
  return env
}

function coerceSize(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value as number)))
}

function resolveCwd(cwd?: string): string {
  const fallback = homedir()
  if (!cwd || typeof cwd !== 'string') return fallback

  try {
    const abs = resolve(cwd)
    if (existsSync(abs) && statSync(abs).isDirectory()) return abs
  } catch {
    // Fall through to home directory.
  }

  return fallback
}

function resolveShell(): { file: string; args: string[]; label: string } {
  if (process.platform === 'win32') {
    const gitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH
    if (gitBash && existsSync(gitBash)) {
      return { file: gitBash, args: [], label: 'bash' }
    }

    const comspec = process.env.ComSpec || process.env.COMSPEC
    if (comspec) {
      return { file: comspec, args: [], label: basename(comspec) }
    }

    return { file: 'powershell.exe', args: ['-NoLogo'], label: 'powershell' }
  }

  const shell = process.env.SHELL || (existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash')
  return { file: shell, args: [], label: basename(shell) }
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (nodePtyHelperPermissionsChecked || process.platform === 'win32') return
  nodePtyHelperPermissionsChecked = true

  try {
    const nodePtyEntry = requireForNodePty.resolve('node-pty')
    const moduleRoot = resolve(dirname(nodePtyEntry), '..')
    const roots = [
      moduleRoot,
      moduleRoot.replace('app.asar', 'app.asar.unpacked'),
      moduleRoot.replace('node_modules.asar', 'node_modules.asar.unpacked'),
    ]

    for (const root of new Set(roots)) {
      for (const helperPath of [
        join(root, 'build', 'Release', 'spawn-helper'),
        join(root, 'build', 'Debug', 'spawn-helper'),
        join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      ]) {
        if (!existsSync(helperPath)) continue

        const mode = statSync(helperPath).mode
        if ((mode & 0o111) === 0) {
          chmodSync(helperPath, (mode & 0o777) | 0o111)
          mainLog.info('[terminal] fixed node-pty spawn-helper executable bit', { helperPath })
        }
      }
    }
  } catch (error) {
    mainLog.warn('[terminal] failed to verify node-pty spawn-helper permissions', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function isDestroyed(webContents: WebContents): boolean {
  try {
    return webContents.isDestroyed()
  } catch {
    return true
  }
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSessionRecord>()

  ensure(input: AttachInput): TerminalSessionSnapshot {
    const sessionId = this.assertSessionId(input.sessionId)
    const cols = coerceSize(input.cols, DEFAULT_COLS, 20, 400)
    const rows = coerceSize(input.rows, DEFAULT_ROWS, 5, 200)
    let session = this.sessions.get(sessionId)

    if (!session || session.status === 'exited') {
      if (session) this.disposeSession(session)
      session = this.createSession(sessionId, input.cwd, cols, rows)
    } else if (cols !== session.cols || rows !== session.rows) {
      this.resize(sessionId, cols, rows)
    }

    return this.toSnapshot(session)
  }

  attach(webContents: WebContents, input: AttachInput): TerminalSessionSnapshot {
    const snapshot = this.ensure(input)
    const session = this.requireRunningSession(snapshot.sessionId)

    session.clients.set(webContents.id, webContents)
    webContents.once('destroyed', () => {
      this.detach(snapshot.sessionId, webContents.id)
    })

    return snapshot
  }

  detach(sessionId: string, webContentsId: number): void {
    const session = this.sessions.get(sessionId)
    session?.clients.delete(webContentsId)
  }

  write(sessionId: string, data: string, source: TerminalWriteSource = 'user'): void {
    const session = this.requireRunningSession(sessionId)
    if (typeof data !== 'string' || data.length === 0) return

    session.pty.write(data)

    if (source === 'agent') {
      mainLog.info('[terminal] agent wrote to shared terminal', {
        sessionId,
        bytes: Buffer.byteLength(data),
      })
    }
  }

  resize(sessionId: string, cols: number, rows: number): TerminalSessionSnapshot {
    const session = this.requireRunningSession(sessionId)
    const nextCols = coerceSize(cols, session.cols, 20, 400)
    const nextRows = coerceSize(rows, session.rows, 5, 200)

    if (nextCols !== session.cols || nextRows !== session.rows) {
      session.pty.resize(nextCols, nextRows)
      session.screen.resize(nextCols, nextRows)
      session.cols = nextCols
      session.rows = nextRows
    }

    return this.toSnapshot(session)
  }

  async read(sessionId: string, fromSeq?: number): Promise<TerminalReadResult> {
    const session = this.sessions.get(this.assertSessionId(sessionId))
    if (!session) {
      return { sessionId, chunks: [], nextSeq: 0, status: 'exited', screenText: '' }
    }

    await session.screenWriteReady

    const startSeq = Number.isFinite(fromSeq) ? Math.max(0, Math.floor(fromSeq as number)) : 0
    return {
      sessionId,
      chunks: session.chunks.filter((chunk) => chunk.seq >= startSeq),
      nextSeq: session.nextSeq,
      status: session.status,
      screenText: this.getScreenText(session),
    }
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(this.assertSessionId(sessionId))
    if (!session) return

    try {
      session.pty.kill()
    } catch (error) {
      mainLog.warn('[terminal] failed to kill pty', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      session.status = 'exited'
      session.exitedAt = Date.now()
      this.sessions.delete(sessionId)
      this.notifyExit(session, {})
      this.disposeSession(session)
    }
  }

  killAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.kill(sessionId)
    }
  }

  private createSession(sessionId: string, requestedCwd: string | undefined, cols: number, rows: number): TerminalSessionRecord {
    const cwd = resolveCwd(requestedCwd)
    const shell = resolveShell()
    ensureNodePtySpawnHelperExecutable()
    const screen = new ScreenTerminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: 1_000,
    })

    const proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: sanitizeEnv(sessionId),
    })

    const record: TerminalSessionRecord = {
      sessionId,
      cwd,
      shell: shell.file,
      shellLabel: shell.label,
      pid: proc.pid,
      pty: proc,
      screen,
      screenWriteReady: Promise.resolve(),
      cols,
      rows,
      status: 'running',
      startedAt: Date.now(),
      nextSeq: 0,
      chunks: [],
      bufferChars: 0,
      clients: new Map(),
    }

    proc.onData((data) => this.handleData(record, data))
    proc.onExit(({ exitCode, signal }) => {
      record.status = 'exited'
      record.exitedAt = Date.now()
      record.exitCode = exitCode
      record.signal = signal
      this.notifyExit(record, { exitCode, signal })
    })

    this.sessions.set(sessionId, record)
    mainLog.info('[terminal] spawned shared pty', {
      sessionId,
      cwd,
      shell: shell.label,
      pid: proc.pid,
    })

    return record
  }

  private handleData(session: TerminalSessionRecord, data: string): void {
    const chunk: TerminalOutputChunk = {
      seq: session.nextSeq++,
      data,
      timestamp: Date.now(),
    }

    session.chunks.push(chunk)
    session.bufferChars += data.length
    const previousScreenWrite = session.screenWriteReady.catch(() => {})
    session.screenWriteReady = previousScreenWrite.then(() => new Promise<void>((resolveWrite) => {
      try {
        session.screen.write(data, resolveWrite)
      } catch (error) {
        mainLog.warn('[terminal] failed to update terminal screen buffer', {
          sessionId: session.sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
        resolveWrite()
      }
    }))

    while (session.bufferChars > MAX_BUFFER_CHARS && session.chunks.length > 1) {
      const removed = session.chunks.shift()
      session.bufferChars -= removed?.data.length ?? 0
    }

    this.broadcastData(session, {
      sessionId: session.sessionId,
      seq: chunk.seq,
      data,
      timestamp: chunk.timestamp,
    })
  }

  private broadcastData(session: TerminalSessionRecord, event: TerminalDataEvent): void {
    for (const [id, client] of session.clients) {
      if (isDestroyed(client)) {
        session.clients.delete(id)
        continue
      }
      client.send(TERMINAL_DATA_CHANNEL, event)
    }
  }

  private broadcastExit(session: TerminalSessionRecord, event: TerminalExitEvent): void {
    for (const [id, client] of session.clients) {
      if (isDestroyed(client)) {
        session.clients.delete(id)
        continue
      }
      client.send(TERMINAL_EXIT_CHANNEL, event)
    }
  }

  private notifyExit(
    session: TerminalSessionRecord,
    info: { exitCode?: number; signal?: number },
  ): void {
    if (session.exitNotified) return
    session.exitNotified = true
    this.broadcastExit(session, {
      sessionId: session.sessionId,
      status: 'exited',
      exitCode: info.exitCode,
      signal: info.signal,
      exitedAt: session.exitedAt ?? Date.now(),
    })
  }

  private toSnapshot(session: TerminalSessionRecord): TerminalSessionSnapshot {
    return {
      sessionId: session.sessionId,
      cwd: session.cwd,
      shell: session.shell,
      shellLabel: session.shellLabel,
      pid: session.pid,
      cols: session.cols,
      rows: session.rows,
      status: session.status,
      startedAt: session.startedAt,
      exitedAt: session.exitedAt,
      exitCode: session.exitCode,
      signal: session.signal,
      nextSeq: session.nextSeq,
      recentOutput: session.chunks.map((chunk) => chunk.data).join(''),
      screenText: this.getScreenText(session),
    }
  }

  private getScreenText(session: TerminalSessionRecord): string {
    try {
      const buffer = session.screen.buffer.active
      const startLine = buffer.type === 'alternate' ? 0 : buffer.baseY
      const lines: string[] = []

      for (let row = 0; row < session.rows; row++) {
        lines.push(buffer.getLine(startLine + row)?.translateToString(true) ?? '')
      }

      return lines.join('\n').replace(/\s+$/g, '')
    } catch (error) {
      mainLog.warn('[terminal] failed to read terminal screen buffer', {
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return ''
    }
  }

  private disposeSession(session: TerminalSessionRecord): void {
    try {
      session.screen.dispose()
    } catch {
      // Best effort cleanup.
    }
  }

  private requireRunningSession(sessionId: string): TerminalSessionRecord {
    const session = this.sessions.get(this.assertSessionId(sessionId))
    if (!session || session.status !== 'running') {
      throw new Error(`Terminal session is not running: ${sessionId}`)
    }
    return session
  }

  private assertSessionId(sessionId: string): string {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('A terminal sessionId is required')
    }
    return sessionId
  }
}

export function registerTerminalIpc(manager: TerminalManager): void {
  ipcMain.handle('terminal:attach', (event, input: AttachInput) => {
    return manager.attach(event.sender, input)
  })

  ipcMain.handle('terminal:detach', (event, sessionId: string) => {
    manager.detach(sessionId, event.sender.id)
  })

  ipcMain.handle('terminal:write', (_event, sessionId: string, data: string, source?: TerminalWriteSource) => {
    manager.write(sessionId, data, source)
  })

  ipcMain.handle('terminal:resize', (_event, sessionId: string, cols: number, rows: number) => {
    return manager.resize(sessionId, cols, rows)
  })

  ipcMain.handle('terminal:read', (_event, sessionId: string, fromSeq?: number) => {
    return manager.read(sessionId, fromSeq)
  })

  ipcMain.handle('terminal:kill', (_event, sessionId: string) => {
    manager.kill(sessionId)
  })
}
