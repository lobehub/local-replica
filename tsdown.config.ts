import { defineConfig } from 'tsdown';

export default defineConfig({
  dts: true,
  entry: ['src/index.ts', 'src/zustand/index.ts'],
  format: ['esm'],
  outDir: 'es',
  platform: 'neutral',
  sourcemap: true,
});
