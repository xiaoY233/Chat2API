import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const testDir = path.resolve('tests/server')
const supportsNativeTypeScript = Boolean(process.features?.typescript)
const files = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith('.test.mjs') || (supportsNativeTypeScript && file.endsWith('.test.ts')))
  .map((file) => path.join(testDir, file))

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
