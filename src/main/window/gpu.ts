/**
 * GPU / software-rendering selection.
 *
 * Chromium initializes ANGLE eagerly at startup. On Linux there is no reliable
 * way to know before `app.ready` whether the X11/Wayland GL stack actually
 * works: a DRI render node can exist while GLX/EGL still fails (NVIDIA driver
 * mismatch, VMs, remote X, Xwayland, containers). When that happens Chromium
 * floods the console with "glxQueryExtensionsString returned NULL" /
 * "Initialization of all EGL display types failed" and falls back to software
 * anyway.
 *
 * This app does not need GPU acceleration, so Linux defaults to software
 * rendering. Set CHAT2API_DISABLE_GPU=0 to force hardware rendering.
 */

export interface GpuEnvironment {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
}

const SOFTWARE_RENDERING_FORCED = new Set(['1', 'true', 'yes'])
const SOFTWARE_RENDERING_DISABLED = new Set(['0', 'false', 'no'])

/**
 * Whether the app should start with software rendering.
 *
 * `CHAT2API_DISABLE_GPU=1` forces it on, `CHAT2API_DISABLE_GPU=0` forces it off.
 * Otherwise Linux defaults to software rendering; other platforms keep
 * hardware acceleration.
 */
export function shouldUseSoftwareRendering(options: GpuEnvironment = {}): boolean {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const override = env.CHAT2API_DISABLE_GPU?.trim().toLowerCase()

  if (override && SOFTWARE_RENDERING_FORCED.has(override)) return true
  if (override && SOFTWARE_RENDERING_DISABLED.has(override)) return false

  return platform === 'linux'
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
