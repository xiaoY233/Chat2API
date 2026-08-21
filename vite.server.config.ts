import { builtinModules } from 'module'
import { resolve } from 'path'
import { defineConfig } from 'vite'

const external = [
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
  'electron',
  'electron-store',
]

export default defineConfig({
  build: {
    outDir: 'out-server',
    emptyOutDir: true,
    target: 'node20',
    ssr: true,
    rollupOptions: {
      input: {
        'server/index': resolve(__dirname, 'src/server/index.ts'),
        'server/bootstrapConfig': resolve(__dirname, 'src/server/bootstrapConfig.ts'),
        'main/runtime/nodeRuntime': resolve(__dirname, 'src/main/runtime/nodeRuntime.ts'),
        'main/store/storage/nodeJsonStore': resolve(__dirname, 'src/main/store/storage/nodeJsonStore.ts'),
      },
      external,
      output: {
        format: 'cjs',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
})
