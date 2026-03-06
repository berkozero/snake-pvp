import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
  },
  webServer: [
    {
      command:
        'PORT=3001 COUNTDOWN_MS=500 MATCH_DURATION_MS=1500 FINISH_DWELL_MS=700 DISCONNECT_GRACE_MS=1200 bun run server',
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'VITE_GAME_SERVER_URL=ws://127.0.0.1:3001/ws bun run dev -- --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
