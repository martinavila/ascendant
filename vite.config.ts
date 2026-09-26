import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

// The classic art in public/classic/ is upscaled from the player's own copy of
// the 1995 game and is copyrighted. Keep it out of builds unless explicitly
// requested for a private, local build (INCLUDE_CLASSIC=1 npm run build).
function stripClassic(): Plugin {
  return {
    name: 'strip-classic-art',
    apply: 'build',
    closeBundle() {
      if (process.env.INCLUDE_CLASSIC === '1') return;
      rmSync(resolve(__dirname, 'dist/classic'), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [preact(), stripClassic()],
  base: './',
  build: { chunkSizeWarningLimit: 1500 },
  test: { include: ['tests/**/*.test.ts'] },
} as any);
