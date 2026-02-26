import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
  resolve: {
    alias: {
      '@core': '/home/peterstorm/dev/claude-plugins/reclaw/src/core',
      '@infra': '/home/peterstorm/dev/claude-plugins/reclaw/src/infra',
      '@orchestration': '/home/peterstorm/dev/claude-plugins/reclaw/src/orchestration',
    },
  },
});
