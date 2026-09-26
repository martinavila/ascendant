import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  base: './',
  test: { include: ['tests/**/*.test.ts'] },
} as any);
