import { defineConfig } from 'vitest/config';
import unitConfig from './vitest.config.mjs';

export default defineConfig({
  ...unitConfig,
  test: {
    ...unitConfig.test,
    name: 'server:fork',
    include: ['test/fork/**/*.spec.ts'],
  },
});
