import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = process.cwd()

const allowedElectronImports = new Set([
  path.normalize('src/main/runtime/electronRuntime.ts'),
])

function walk(dir) {
  if (!fs.existsSync(dir)) {
    return []
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(fullPath))
    } else if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath)
    }
  }

  return files
}

test('server-owned files do not import electron directly', () => {
  const checkedRoots = [
    path.join(repoRoot, 'src/server'),
    path.join(repoRoot, 'src/main/runtime'),
    path.join(repoRoot, 'src/main/store/storage'),
  ]

  const violations = []

  for (const root of checkedRoots) {
    for (const file of walk(root)) {
      const relative = path.normalize(path.relative(repoRoot, file))
      if (allowedElectronImports.has(relative)) {
        continue
      }

      const source = fs.readFileSync(file, 'utf8')
      if (source.includes("from 'electron'") || source.includes('from "electron"')) {
        violations.push(relative)
      }
    }
  }

  assert.deepEqual(violations, [])
})
