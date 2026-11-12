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

import { readdirSync } from 'fs'

export interface GpuEnvironment {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  driDeviceExists?: boolean
}

const SOFTWARE_RENDERING_FORCED = new Set(['1', 'true', 'yes'])
const SOFTWARE_RENDERING_DISABLED = new Set(['0', 'false', 'no'])

/**
 * Whether a hardware GL driver is actually usable.
 *
 * A `/dev/dri/card0` on its own is not enough: Chromium needs a render node
 * (`/dev/dri/renderD*`) to get an EGL/GLX context. Containers, proot-distros
 * and Android/Termux setups commonly expose `card0` without any render node,
 * which is why ANGLE reports `glxQueryExtensionsString returned NULL` and
 * `Initialization of all EGL display types failed`.
 */
function hasGpuRenderNode(): boolean {
  try {
    return readdirSync('/dev/dri').some((entry) => entry.startsWith('renderD'))
  } catch {
    return false
  }
}

/**
 * Whether the app should start with software rendering.
 *
 * `CHAT2API_DISABLE_GPU=1` forces it on, `CHAT2API_DISABLE_GPU=0` forces it off.
 * Otherwise only Linux is inspected: no display server, no DRI render node, or
 * a nested container runtime means there is no usable hardware GL.
 */
export function shouldUseSoftwareRendering(options: GpuEnvironment = {}): boolean {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const override = env.CHAT2API_DISABLE_GPU?.trim().toLowerCase()

  if (override && SOFTWARE_RENDERING_FORCED.has(override)) return true
  if (override && SOFTWARE_RENDERING_DISABLED.has(override)) return false
  if (platform !== 'linux') return false

  const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
  if (!hasDisplay) return true

  // Running inside proot/termux means /dev/dri nodes cannot be driven properly
  // even when they are visible in the mount namespace.
  if (env.PROOT_L2S_DIR || env.TERMUX_EXEC__PROC_SELF_EXE) return true

  const driDeviceExists = options.driDeviceExists ?? hasGpuRenderNode()
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
