import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Native / heavy deps stay unbundled. bcryptjs bundled under PM2 produced
  // intermittent auth failures on sibling projects; baileys is imported
  // lazily so the process boots on a host without it.
  external: ['bcryptjs', '@prisma/client', 'baileys', 'qrcode', '@anthropic-ai/sdk'],
})
