import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const testRoot = process.env.TEST_ROOT
  || path.join(repoRoot, '.local', 'idle-watchdog-test')
const fixture = path.join(import.meta.dirname, 'claude-stream-idle-fixture.mjs')
const contentDelayMs = process.env.CONTENT_DELAY_MS || '315000'

fs.mkdirSync(testRoot, { recursive: true })

function launch(name, port, streamWatchdog) {
  const stdout = fs.openSync(path.join(testRoot, `${name}.out.log`), 'w')
  const stderr = fs.openSync(path.join(testRoot, `${name}.err.log`), 'w')
  const env = {
    ...process.env,
    PORT: String(port),
    CONTENT_DELAY_MS: contentDelayMs,
    PING_INTERVAL_MS: process.env.PING_INTERVAL_MS || '1000',
    PROGRESS_MODE: process.env.PROGRESS_MODE || 'ping',
    RUN_CLAUDE: '1',
    CLAUDE_CONFIG_DIR: path.join(testRoot, `${name}-config`),
  }

  delete env.CLAUDE_ENABLE_STREAM_WATCHDOG
  if (streamWatchdog !== undefined) {
    env.CLAUDE_ENABLE_STREAM_WATCHDOG = String(streamWatchdog)
  }

  const child = spawn(process.execPath, [fixture], {
    detached: true,
    env,
    stdio: ['ignore', stdout, stderr],
    windowsHide: true,
  })
  child.unref()
  fs.closeSync(stdout)
  fs.closeSync(stderr)
  return child.pid
}

const controlPort = Number.parseInt(process.env.CONTROL_PORT || '18191', 10)
const fixedPort = Number.parseInt(process.env.FIXED_PORT || '18192', 10)
const run = {
  startedAt: new Date().toISOString(),
  contentDelayMs: Number.parseInt(contentDelayMs, 10),
  control: { pid: launch('control', controlPort), port: controlPort },
  fixed: { pid: launch('fixed', fixedPort, false), port: fixedPort },
}

fs.writeFileSync(
  path.join(testRoot, 'run.json'),
  `${JSON.stringify(run, null, 2)}\n`,
  'utf8',
)
process.stdout.write(`${JSON.stringify(run)}\n`)
