#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_SCAN_ROOTS = [
  '.',
  'src/main',
  'src/preload',
  'src/shared',
]

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'backup',
  'src/renderer/next-app',
])

function toPosix(filePath) {
  return filePath.split(path.sep).join('/')
}

function hasTypeScriptSourceSibling(filePath) {
  if (filePath.endsWith('.d.ts')) {
    const sourcePath = filePath.slice(0, -5) + '.ts'
    return fs.existsSync(sourcePath)
  }

  if (!filePath.endsWith('.js')) {
    return false
  }

  const basePath = filePath.slice(0, -3)
  return fs.existsSync(`${basePath}.ts`) || fs.existsSync(`${basePath}.tsx`)
}

function shouldSkipDirectory(root, directory) {
  const relative = toPosix(path.relative(root, directory))
  if (!relative || relative === '.') {
    return false
  }
  return SKIP_DIRS.has(relative) || relative.split('/').some(part => SKIP_DIRS.has(part))
}

function walkDirectory(root, directory, artifacts) {
  if (!fs.existsSync(directory) || shouldSkipDirectory(root, directory)) {
    return
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      walkDirectory(root, fullPath, artifacts)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    if ((entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) && hasTypeScriptSourceSibling(fullPath)) {
      artifacts.push(toPosix(path.relative(root, fullPath)))
    }
  }
}

function findSourceArtifacts(root = process.cwd(), scanRoots = DEFAULT_SCAN_ROOTS) {
  const resolvedRoot = path.resolve(root)
  const artifacts = []

  for (const scanRoot of scanRoots) {
    walkDirectory(resolvedRoot, path.join(resolvedRoot, scanRoot), artifacts)
  }

  return [...new Set(artifacts)].sort()
}

function removeSourceArtifacts(root = process.cwd(), scanRoots = DEFAULT_SCAN_ROOTS) {
  const resolvedRoot = path.resolve(root)
  const artifacts = findSourceArtifacts(resolvedRoot, scanRoots)

  for (const artifact of artifacts) {
    fs.unlinkSync(path.join(resolvedRoot, artifact))
  }

  return artifacts
}

function main() {
  const shouldDelete = process.argv.includes('--delete')
  const artifacts = findSourceArtifacts(process.cwd())

  if (artifacts.length === 0) {
    console.log('No generated JavaScript or declaration artifacts found next to TypeScript sources.')
    return
  }

  if (shouldDelete) {
    const removed = removeSourceArtifacts(process.cwd())
    console.log(`Removed ${removed.length} generated JavaScript/declaration artifacts.`)
    for (const artifact of removed) {
      console.log(`  - ${artifact}`)
    }
    return
  }

  console.error('Generated JavaScript/declaration artifacts found next to TypeScript sources:')
  for (const artifact of artifacts) {
    console.error(`  - ${artifact}`)
  }
  console.error('\nRemove these files before building; they can shadow the .ts source during bundling.')
  process.exitCode = 1
}

if (require.main === module) {
  main()
}

module.exports = {
  findSourceArtifacts,
  removeSourceArtifacts,
}
