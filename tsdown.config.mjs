/**
 * tsdown configuration for the dsh-auv Host plugin bundle.
 *
 * The published/installed artifact is one self-contained ESM file,
 * `dist/index.mjs`: the tool definitions, the generated AUV catalog, and the
 * es-toolkit helpers are inlined, while Node builtins stay external. Static
 * DSH resources (`cordis.patch.yml`, `locale/*.json`, `icon.svg`) are not
 * bundled and stay next to the manifest.
 *
 * Build: pnpm build
 */

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['index.js'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: false,
  report: true,
})
