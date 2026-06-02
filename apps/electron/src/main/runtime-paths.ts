import type { App } from 'electron'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'

function findAncestor(base: string, predicate: (dir: string) => boolean, maxLevels = 10): string | null {
  let dir = resolve(base)
  for (let i = 0; i <= maxLevels; i++) {
    if (predicate(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function looksLikeRepositoryRoot(dir: string): boolean {
  return existsSync(join(dir, 'package.json'))
    && existsSync(join(dir, 'apps', 'electron', 'package.json'))
    && existsSync(join(dir, 'packages', 'pi-agent-server'))
}

/**
 * Runtime app root used by backend path resolution.
 *
 * In source runs launched through `open -na Electron.app --args <app>`,
 * `process.cwd()` can be `/`. Electron still knows the real app path, so use
 * `app.getAppPath()` for non-packaged runs and let shared resolvers walk up to
 * the monorepo root when they need `packages/...` assets.
 */
export function getElectronRuntimeAppRoot(app: App): string {
  return app.getAppPath()
}

/**
 * Monorepo root for source-only assets/scripts that live outside apps/electron.
 */
export function getElectronDevelopmentRoot(app: App): string {
  if (app.isPackaged) return app.getAppPath()

  const cwd = process.cwd()
  if (looksLikeRepositoryRoot(cwd)) return cwd

  const fromAppPath = findAncestor(app.getAppPath(), looksLikeRepositoryRoot)
  if (fromAppPath) return fromAppPath

  return cwd
}
