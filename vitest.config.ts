import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/**/*.test.ts', 'src/zustand/testUtils.ts'],
      include: ['src/**/*.ts'],
      reporter: ['text', 'json'],
      thresholds: { 100: true },
    },
    environment: 'happy-dom',
  },
});
