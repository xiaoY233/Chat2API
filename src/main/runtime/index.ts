import type { RuntimeAdapter } from './types.ts'
import { nodeRuntime } from './nodeRuntime.ts'

let runtime: RuntimeAdapter = nodeRuntime

export function setRuntime(nextRuntime: RuntimeAdapter): void {
  runtime = nextRuntime
}

export function getRuntime(): RuntimeAdapter {
  return runtime
}

export type { RuntimeAdapter }
