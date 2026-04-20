import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'node:child_process'

function resolveCommit(): string {
  const fromVercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromVercel) return fromVercel.slice(0, 7);
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .slice(0, 7);
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_COMMIT__: JSON.stringify(resolveCommit()),
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // @ts-expect-error vitest extends the vite config
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'e2e/**', '**/playwright/**'],
    pool: 'threads',
    poolOptions: {
      threads: { maxThreads: 4 },
    },
    // Integration tests in tests/api/ do 4-5 Postgres round trips
    // over Neon from CI. At ~300-800ms per round trip on a slow GA
    // moment that's easily 3-4s, leaving no headroom over vitest's
    // default 5000ms. 15s is plenty for a real test without masking
    // a genuine hang — any test that sits for 15s is a bug, not a
    // slow network. (Fixed after run 24653105703 timed out on two
    // Postgres-heavy tests with no code changes since a prior green.)
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
