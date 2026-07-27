function parsePort(value: string | undefined): number {
  const port = Number(value || '8080')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CHAT2API_PORT must be an integer between 1 and 65535, received: ${value}`)
  }
  return port
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, received: ${value}`)
  }
  return parsed
}

export type HeadlessConfig = {
  host: string
  port: number
  shutdownTimeoutMs: number
}

export function loadHeadlessConfig(): HeadlessConfig {
  return {
    host: process.env.CHAT2API_HOST || '0.0.0.0',
    port: parsePort(process.env.CHAT2API_PORT),
    shutdownTimeoutMs: parsePositiveInteger(
      process.env.CHAT2API_SHUTDOWN_TIMEOUT,
      20_000,
      'CHAT2API_SHUTDOWN_TIMEOUT',
    ),
  }
}
