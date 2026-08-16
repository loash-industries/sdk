import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [dts({ tsconfigPath: './tsconfig.build.json' })],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    outDir: 'dist',
    rollupOptions: {
      // Peer deps stay external — never bundled into the SDK.
      external: ['@mysten/sui', /^@mysten\/sui\//, 'zod'],
    },
  },
})
