import * as React from 'react'
import { Terminal as TerminalIcon, X, Trash2, OctagonX, Power } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/ThemeContext'
import { getResizeGradientStyle } from '@/hooks/useResizeGradient'
import {
  PANEL_GAP,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
} from './panel-constants'
import type { TerminalSessionSnapshot } from '../../../shared/types'

interface AgentTerminalPanelProps {
  sessionId: string
  cwd?: string
  compactMode?: boolean
  width?: number
  onWidthChange?: (width: number) => void
  onClose: () => void
}

const TERMINAL_MIN_WIDTH = 340
const TERMINAL_DEFAULT_WIDTH = 520
const TERMINAL_MAX_WIDTH = 920
const TERMINAL_FONT_FAMILY = '"SF Mono", Menlo, Monaco, "Cascadia Mono", "JetBrains Mono", "Fira Code", monospace'

const DARK_TERMINAL_THEME = {
  background: '#0b0f14',
  foreground: '#d6deeb',
  cursor: '#f8fafc',
  cursorAccent: '#0b0f14',
  selectionBackground: '#2f5f87',
  black: '#10151d',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d6deeb',
  brightBlack: '#6b7280',
  brightRed: '#fb7185',
  brightGreen: '#4ade80',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
}

const LIGHT_TERMINAL_THEME = {
  background: '#fbfafc',
  foreground: '#27242c',
  cursor: '#27242c',
  cursorAccent: '#fbfafc',
  selectionBackground: 'rgba(104, 78, 133, 0.22)',
  black: '#24212a',
  red: '#b42318',
  green: '#117043',
  yellow: '#8a5a00',
  blue: '#2559c7',
  magenta: '#7c3fb2',
  cyan: '#0f6f7d',
  white: '#e4e1e8',
  brightBlack: '#8d8894',
  brightRed: '#d92d20',
  brightGreen: '#039855',
  brightYellow: '#b7791f',
  brightBlue: '#3267d6',
  brightMagenta: '#9556d6',
  brightCyan: '#0e8794',
  brightWhite: '#ffffff',
}

function normalizeDimensions(dimensions: { cols: number; rows: number } | undefined) {
  return {
    cols: Math.max(20, Math.floor(dimensions?.cols ?? 100)),
    rows: Math.max(5, Math.floor(dimensions?.rows ?? 30)),
  }
}

export function AgentTerminalPanel({
  sessionId,
  cwd,
  compactMode = false,
  width = TERMINAL_DEFAULT_WIDTH,
  onWidthChange,
  onClose,
}: AgentTerminalPanelProps) {
  const terminalHostRef = React.useRef<HTMLDivElement | null>(null)
  const terminalRef = React.useRef<Terminal | null>(null)
  const fitAddonRef = React.useRef<FitAddon | null>(null)
  const resizeTimerRef = React.useRef<number | null>(null)
  const resizeHandleRef = React.useRef<HTMLDivElement | null>(null)
  const [snapshot, setSnapshot] = React.useState<TerminalSessionSnapshot | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [isAttached, setIsAttached] = React.useState(false)
  const [isResizing, setIsResizing] = React.useState(false)
  const [resizeHandleY, setResizeHandleY] = React.useState<number | null>(null)
  const { isDark } = useTheme()
  const terminalTheme = React.useMemo(() => isDark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME, [isDark])
  const panelWidth = Math.max(TERMINAL_MIN_WIDTH, Math.min(TERMINAL_MAX_WIDTH, width))

  const fitAndResizePty = React.useCallback(() => {
    const fitAddon = fitAddonRef.current
    const terminal = terminalRef.current
    if (!fitAddon || !terminal) return

    try {
      fitAddon.fit()
      const dimensions = normalizeDimensions(fitAddon.proposeDimensions())
      window.electronAPI.terminal
        .resize(sessionId, dimensions.cols, dimensions.rows)
        .then(setSnapshot)
        .catch(() => {})
    } catch {
      // xterm can report zero-sized cells while a drawer is animating.
    }
  }, [sessionId])

  React.useEffect(() => {
    const host = terminalHostRef.current
    if (!host) return

    const terminal = new Terminal({
      allowProposedApi: false,
      allowTransparency: false,
      customGlyphs: true,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: 0,
      lineHeight: 1.32,
      minimumContrastRatio: 4.5,
      scrollback: 10_000,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      theme: terminalTheme,
    })
    const fitAddon = new FitAddon()

    terminal.loadAddon(fitAddon)
    terminal.open(host)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    let disposed = false

    document.fonts?.ready
      .then(() => {
        if (disposed) return
        terminal.options.letterSpacing = 0
        terminal.refresh(0, terminal.rows - 1)
        fitAndResizePty()
      })
      .catch(() => {})

    const dimensions = normalizeDimensions(fitAddon.proposeDimensions())
    const dataDisposable = terminal.onData((data) => {
      window.electronAPI.terminal.write(sessionId, data, 'user').catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
    })

    setError(null)
    setIsAttached(false)

    window.electronAPI.terminal
      .attach({
        sessionId,
        cwd,
        cols: dimensions.cols,
        rows: dimensions.rows,
      })
      .then((nextSnapshot) => {
        if (disposed) return
        setSnapshot(nextSnapshot)
        setIsAttached(nextSnapshot.status === 'running')
        if (nextSnapshot.recentOutput) {
          terminal.write(nextSnapshot.recentOutput)
        }
        requestAnimationFrame(() => {
          fitAndResizePty()
          terminal.focus()
        })
      })
      .catch((err) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err))
      })

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimerRef.current != null) {
        window.clearTimeout(resizeTimerRef.current)
      }
      resizeTimerRef.current = window.setTimeout(fitAndResizePty, 80)
    })
    resizeObserver.observe(host)

    return () => {
      disposed = true
      resizeObserver.disconnect()
      if (resizeTimerRef.current != null) {
        window.clearTimeout(resizeTimerRef.current)
      }
      window.electronAPI.terminal.detach(sessionId).catch(() => {})
      dataDisposable.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [cwd, fitAndResizePty, sessionId, terminalTheme])

  React.useEffect(() => {
    const cleanupData = window.electronAPI.terminal.onData((event) => {
      if (event.sessionId !== sessionId) return
      terminalRef.current?.write(event.data)
    })
    const cleanupExit = window.electronAPI.terminal.onExit((event) => {
      if (event.sessionId !== sessionId) return
      setIsAttached(false)
      setSnapshot((current) => current ? {
        ...current,
        status: 'exited',
        exitedAt: event.exitedAt,
        exitCode: event.exitCode,
        signal: event.signal,
      } : current)
      terminalRef.current?.writeln('')
      terminalRef.current?.writeln(`[shared terminal exited${event.exitCode != null ? ` with code ${event.exitCode}` : ''}]`)
    })

    return () => {
      cleanupData()
      cleanupExit()
    }
  }, [sessionId])

  const handleInterrupt = React.useCallback(() => {
    window.electronAPI.terminal.write(sessionId, '\x03', 'user').catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
    terminalRef.current?.focus()
  }, [sessionId])

  const handleClear = React.useCallback(() => {
    terminalRef.current?.clear()
    terminalRef.current?.focus()
  }, [])

  const handleKill = React.useCallback(() => {
    window.electronAPI.terminal.kill(sessionId).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }, [sessionId])

  const handleResizePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (compactMode || !onWidthChange) return
    event.preventDefault()

    const startX = event.clientX
    const startWidth = panelWidth
    const maxWidth = Math.max(TERMINAL_MIN_WIDTH, Math.min(TERMINAL_MAX_WIDTH, window.innerWidth - 360))
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setIsResizing(true)
    if (resizeHandleRef.current) {
      const rect = resizeHandleRef.current.getBoundingClientRect()
      setResizeHandleY(event.clientY - rect.top)
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = startWidth + startX - moveEvent.clientX
      onWidthChange(Math.max(TERMINAL_MIN_WIDTH, Math.min(maxWidth, Math.round(nextWidth))))
      if (resizeHandleRef.current) {
        const rect = resizeHandleRef.current.getBoundingClientRect()
        setResizeHandleY(moveEvent.clientY - rect.top)
      }
    }

    const handlePointerUp = () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      setIsResizing(false)
      setResizeHandleY(null)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { once: true })
  }, [compactMode, onWidthChange, panelWidth])

  const handleResizeKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (compactMode || !onWidthChange) return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' ? 1 : -1
    onWidthChange(Math.max(TERMINAL_MIN_WIDTH, Math.min(TERMINAL_MAX_WIDTH, panelWidth + direction * 24)))
  }, [compactMode, onWidthChange, panelWidth])

  const shellLabel = snapshot?.shellLabel || 'shell'
  const displayCwd = snapshot?.cwd || cwd || ''
  const resizeGradientStyle = getResizeGradientStyle(
    resizeHandleY,
    resizeHandleRef.current?.clientHeight ?? null,
  )

  return (
    <aside
      className={cn(
        'relative flex min-h-0 flex-col overflow-hidden bg-background text-foreground',
        compactMode
          ? 'fixed inset-0 z-[var(--z-modal)]'
          : 'min-w-[340px] shadow-middle'
      )}
      style={compactMode ? undefined : {
        width: panelWidth,
        marginLeft: PANEL_GAP,
      }}
      aria-label="Shared terminal"
    >
      {!compactMode && (
        <div
          ref={resizeHandleRef}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize terminal"
          aria-valuetext={`${panelWidth}px`}
          aria-valuemin={TERMINAL_MIN_WIDTH}
          aria-valuemax={TERMINAL_MAX_WIDTH}
          aria-valuenow={panelWidth}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onPointerMove={(event) => {
            if (!resizeHandleRef.current) return
            const rect = resizeHandleRef.current.getBoundingClientRect()
            setResizeHandleY(event.clientY - rect.top)
          }}
          onPointerLeave={() => {
            if (!isResizing) setResizeHandleY(null)
          }}
          onKeyDown={handleResizeKeyDown}
          title="Drag to resize terminal"
          className="absolute bottom-0 top-0 z-20 flex cursor-col-resize justify-center focus-visible:outline-none"
          style={{
            left: -(PANEL_GAP / 2) - PANEL_SASH_HALF_HIT_WIDTH,
            width: PANEL_SASH_HIT_WIDTH,
          }}
        >
          <div
            className="h-full"
            style={{
              ...resizeGradientStyle,
              width: PANEL_SASH_LINE_WIDTH,
            }}
          />
        </div>
      )}
      <header className="flex h-[42px] shrink-0 items-center justify-between gap-2 bg-background px-3 shadow-bottom-border-thin">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                isAttached ? 'bg-success ring-2 ring-success/20' : 'bg-foreground/30'
              )}
              aria-hidden="true"
            />
            <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-xs font-semibold text-foreground">Terminal</span>
            <span className="rounded-full bg-foreground-5 px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-thin">
              {shellLabel}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={displayCwd}>
            cwd: {displayCwd}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Close terminal"
          title="Close terminal"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto bg-foreground-2 px-2 py-2 shadow-bottom-border-thin">
        <button
          type="button"
          onClick={handleInterrupt}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] bg-background px-2 text-xs text-foreground/70 shadow-minimal transition-colors hover:bg-foreground-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <OctagonX className="h-3.5 w-3.5" />
          Ctrl-C
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] bg-background px-2 text-xs text-foreground/70 shadow-minimal transition-colors hover:bg-foreground-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Clear
        </button>
        <button
          type="button"
          onClick={handleKill}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] bg-destructive/10 px-2 text-xs text-destructive shadow-thin transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Power className="h-3.5 w-3.5" />
          Kill
        </button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <div
          ref={terminalHostRef}
          className="agent-terminal-xterm h-full w-full px-2.5 py-2"
          style={{
            fontFamily: TERMINAL_FONT_FAMILY,
            fontVariantLigatures: 'none',
            letterSpacing: 0,
          }}
        />
        {error && (
          <div className="absolute left-3 right-3 top-3 rounded-[8px] bg-background px-3 py-2 text-xs text-destructive shadow-modal-small">
            {error}
          </div>
        )}
      </div>

      <footer className="flex min-h-7 shrink-0 items-center gap-2 overflow-hidden border-t border-border/60 bg-foreground-2 px-3 text-[11px] text-muted-foreground">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', isAttached ? 'bg-success' : 'bg-muted-foreground/50')} />
        <span className="shrink-0">{isAttached ? 'Agent attached' : 'Detached'}</span>
        <span className="shrink-0">Shared PTY terminal</span>
        <span className="truncate">{snapshot?.pid ? `pid ${snapshot.pid}` : shellLabel}</span>
      </footer>
    </aside>
  )
}
