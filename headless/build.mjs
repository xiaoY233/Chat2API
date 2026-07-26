import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { applyHeadlessPatches } from './patches/index.mjs'

const headlessRoot = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(headlessRoot, '..')
const stagingRoot = join(headlessRoot, '.build')
const outputRoot = join(headlessRoot, 'dist')

if (process.argv.includes('--clean')) {
  rmSync(stagingRoot, { recursive: true, force: true })
  rmSync(outputRoot, { recursive: true, force: true })
  process.exit(0)
}

function stageSources() {
  rmSync(stagingRoot, { recursive: true, force: true })
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(join(stagingRoot, 'headless'), { recursive: true })
  mkdirSync(outputRoot, { recursive: true })

  cpSync(join(projectRoot, 'src'), join(stagingRoot, 'src'), { recursive: true })
  cpSync(join(headlessRoot, 'src'), join(stagingRoot, 'headless', 'src'), { recursive: true })

  applyHeadlessPatches(stagingRoot)
}

function normalizePath(value) {
  return normalize(value).split(sep).join('/')
}

function replacementPlugin() {
  const shimRoot = join(stagingRoot, 'headless', 'src', 'shims')
  const unsupportedRoot = join(stagingRoot, 'headless', 'src', 'unsupported')
  const exactPackages = new Map([
    ['electron', join(shimRoot, 'electron.ts')],
    ['electron-store', join(shimRoot, 'electron-store.ts')],
  ])
  const pathReplacements = [
    {
      matches: value => value.endsWith('/src/main/providers/builtin') ||
        value.endsWith('/src/main/providers/builtin/index') ||
        value.endsWith('/src/main/providers/builtin/index.ts'),
      path: join(shimRoot, 'selectedProviders.ts'),
    },
    {
      matches: value => value.endsWith('/src/main/proxy/routes/management/proxy') ||
        value.endsWith('/src/main/proxy/routes/management/proxy.ts'),
      path: join(shimRoot, 'managementProxy.ts'),
    },
    {
      matches: value => value.endsWith('/src/main/proxy/adapters/mimo') ||
        value.endsWith('/src/main/proxy/adapters/mimo.ts'),
      path: join(unsupportedRoot, 'mimo.ts'),
    },
    {
      matches: value => value.endsWith('/src/main/proxy/adapters/qwen') ||
        value.endsWith('/src/main/proxy/adapters/qwen.ts'),
      path: join(unsupportedRoot, 'qwen.ts'),
    },
    {
      matches: value => value.endsWith('/src/main/proxy/adapters/qwen-ai') ||
        value.endsWith('/src/main/proxy/adapters/qwen-ai.ts'),
      path: join(unsupportedRoot, 'qwen-ai.ts'),
    },
    {
      matches: value => value.endsWith('/src/main/proxy/adapters/perplexity') ||
        value.endsWith('/src/main/proxy/adapters/perplexity.ts'),
      path: join(unsupportedRoot, 'perplexity.ts'),
    },
    {
      matches: value => value.endsWith('/src/main/proxy/adapters/perplexity-stream') ||
        value.endsWith('/src/main/proxy/adapters/perplexity-stream.ts'),
      path: join(unsupportedRoot, 'perplexity-stream.ts'),
    },
  ]

  return {
    name: 'chat2api-headless-replacements',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^[^./][^:]*$/ }, args => {
        const replacement = exactPackages.get(args.path)
        return replacement ? { path: replacement } : null
      })

      buildContext.onResolve({ filter: /^\.{1,2}\// }, args => {
        const candidate = normalizePath(resolve(args.resolveDir, args.path))
        const replacement = pathReplacements.find(entry => entry.matches(candidate))
        return replacement ? { path: replacement.path } : null
      })
    },
  }
}

function assertBundleGraph(metafile) {
  const inputs = Object.keys(metafile.inputs).map(normalizePath)
  const forbidden = [
    '/src/main/index.ts',
    '/src/main/oauth/',
    '/src/main/proxy/adapters/perplexity.ts',
    '/src/main/proxy/adapters/perplexity-stream.ts',
    '/src/main/proxy/adapters/qwen.ts',
    '/src/main/proxy/adapters/qwen-ai.ts',
    '/src/main/proxy/adapters/mimo.ts',
  ]
  const violations = inputs.filter(input => forbidden.some(value => input.includes(value)))
  if (violations.length > 0) {
    throw new Error(`Forbidden modules entered the headless bundle:\n${violations.join('\n')}`)
  }
}

stageSources()

const result = await build({
  absWorkingDir: stagingRoot,
  entryPoints: {
    server: join(stagingRoot, 'headless', 'src', 'entry.ts'),
    'chat2api-ctl': join(stagingRoot, 'headless', 'src', 'cli.ts'),
  },
  bundle: true,
  entryNames: '[name]',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outdir: outputRoot,
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
  plugins: [replacementPlugin()],
  nodePaths: [join(headlessRoot, 'node_modules')],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
})

assertBundleGraph(result.metafile)
writeFileSync(join(outputRoot, 'meta.json'), JSON.stringify(result.metafile, null, 2))

const wasmSource = join(projectRoot, 'sha3_wasm_bg.7b9ca65ddd.wasm')
if (!existsSync(wasmSource)) {
  throw new Error(`DeepSeek WASM resource is missing: ${wasmSource}`)
}
mkdirSync(join(outputRoot, 'resources'), { recursive: true })
cpSync(wasmSource, join(outputRoot, 'resources', 'sha3_wasm_bg.7b9ca65ddd.wasm'))

for (const outputName of ['server.js', 'chat2api-ctl.js']) {
  const outputPath = join(outputRoot, outputName)
  const contents = readFileSync(outputPath, 'utf8')
  if (contents.includes('from "electron"') || contents.includes("from 'electron'")) {
    throw new Error(`${outputName} still contains a runtime Electron import`)
  }
  for (const marker of [
    'encryptData input length',
    'Account credentials:',
    'Validating Token:',
    'Query string:',
    "[GLM] Response data:",
  ]) {
    if (contents.includes(marker)) {
      throw new Error(`${outputName} still contains sensitive log marker: ${marker}`)
    }
  }
}

console.log(`Headless bundle written to ${relative(projectRoot, outputRoot)}`)
