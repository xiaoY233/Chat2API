/**
 * GPU / software-rendering selection.
 *
 * Chromium initializes ANGLE eagerly at startup. On machines without a usable
 * GL/EGL stack — headless containers, Xvfb, remote X sessions, VMs without DRI
 * nodes — that initialization fails and floods the console with
 * "glxQueryExtensionsString returned NULL" / "Initialization of all EGL display
 * types failed" before falling back to software anyway. Picking software
 * rendering up front skips that dead end and keeps WebGL available through
 * SwiftShader.
 */

import { existsSync } from 'fs'

export interface GpuEnvironment {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  driDeviceExists?: boolean
}

/**
 * Whether the app should start with software rendering.
 *
 * `CHAT2API_DISABLE_GPU=1` forces it on, `CHAT2API_DISABLE_GPU=0` forces it off.
 * Otherwise only Linux is inspected: no display server, or a display server
 * without `/dev/dri`, means there is no hardware GL to use.
 */
export function shouldUseSoftwareRendering(options: GpuEnvironment = {}): boolean {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const override = env.CHAT2API_DISABLE_GPU?.trim()

  if (override === '1' || override === 'true') return true
  if (override === '0' || override === 'false') return false
  if (platform !== 'linux') return false

  const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
  if (!hasDisplay) return true

  const driDeviceExists = options.driDeviceExists ?? existsSync('/dev/dri')
  return !driDeviceExists
}

interface GpuApp {
  disableHardwareAcceleration: () => void
  commandLine: { appendSwitch: (name: string, value?: string) => void }
}

/** Applies the software-rendering switches. Must run before `app.ready`. */
export function applySoftwareRenderingSwitches(app: GpuApp): void {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  // Chromium 130+ (Electron 33) refuses software WebGL without this.
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}
