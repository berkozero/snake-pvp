# Snake PVP

An online 1v1 Snake game with an authoritative Bun WebSocket server and a thin React/Vite client.

Two players claim named slots, join the same room, chase the same food, grow longer, cut each other's body, and fight for the highest score before the timer ends.

## Gameplay

- Classic grid-based movement inspired by old-school Nokia Snake
- 2 online players in one shared room
- Authoritative 100ms server simulation
- 3-minute matches by default with live score tracking
- Eating food gives `+1` score and grows your snake
- Hitting your own body or a wall kills you
- Biting an enemy body segment cuts off the rest of their tail
- Longer snake wins head-on collisions; equal length knocks both out
- If score is tied at time up, current snake length is the tiebreaker

## Controls

- Movement on every client: arrow keys
- Start when room is ready: `Enter`

## Visual Style

- Black arena and background
- Distinct snake colors for each player
- Bright food dot for easy tracking
- Retro arcade / Nokia-inspired presentation with modern UI polish

## Run Locally

```bash
bun install
cp .env.example .env
PORT=3001 bun run server
VITE_GAME_SERVER_URL=ws://127.0.0.1:3001/ws bun run dev
```

Or in two terminals:

```bash
bun run dev:server
bun run dev
```

The frontend defaults to `ws://127.0.0.1:3001/ws` if `VITE_GAME_SERVER_URL` is not set.

Health check:

```bash
curl http://127.0.0.1:3001/health
```

## Scripts

```bash
bun run dev
bun run dev:server
bun run server
bun run test
bun run e2e
bun run build
bun run test:all
```

## Automated Testing

This project includes:

- `Vitest` for deterministic gameplay engine tests
- `Playwright` for headless browser flow testing
- `Vite build` for production build verification

## Environment

- Copy `.env.example` to `.env` for local development.
- Frontend: `VITE_GAME_SERVER_URL`
- Server: `PORT`, `HOST`
- Optional server tuning: `COUNTDOWN_MS`, `MATCH_DURATION_MS`, `SERVER_TICK_MS`, `DISCONNECT_GRACE_MS`, `FINISH_DWELL_MS`, `LIVENESS_TIMEOUT_MS`, `RATE_LIMIT_PER_SECOND`

## Deploy

Use Railway for the Bun WebSocket match server and Vercel for the static Vite frontend.

### Railway

This repo includes [`railway.json`](/Users/berkozer/Documents/snake-pvp/railway.json), so Railway can use the correct start command and health check automatically.

Expected runtime:

- Start command: `bun run server`
- Health check: `/health`
- Host: `0.0.0.0`
- Port: Railway-provided `PORT`

Recommended Railway variables:

```bash
HOST=0.0.0.0
```

After deploy, note the public server URL, for example:

```text
https://snake-pvp-server.up.railway.app
```

Your frontend should point at:

```text
wss://snake-pvp-server.up.railway.app/ws
```

Quick verification:

```bash
curl https://snake-pvp-server.up.railway.app/health
```

### Vercel

This repo includes [`vercel.json`](/Users/berkozer/Documents/snake-pvp/vercel.json), which pins the Bun install/build commands and serves the Vite SPA from `dist`.

Required Vercel environment variable:

```bash
VITE_GAME_SERVER_URL=wss://snake-pvp-server.up.railway.app/ws
```

Important:

- Use `wss://` in production, not `ws://`
- Deploy the Railway backend first so the Vercel build can be configured with the final WebSocket URL
- Vercel hosts only the frontend for this repo; the Bun server stays on Railway

### CLI Flow

Vercel CLI is installed locally in this environment. Railway CLI can be used via `bunx @railway/cli`.

Typical commands:

```bash
# frontend
vercel
vercel --prod

# backend
bunx @railway/cli login
bunx @railway/cli link
bunx @railway/cli up
```

If you prefer not to use the CLI, create the Railway service from GitHub in the dashboard, then use the generated Railway URL in the Vercel env var above.

### Post-Deploy Checks

1. Open the Vercel frontend URL.
2. Confirm the client connects successfully.
3. Open the Railway `/health` URL.
4. Join from two separate browser contexts.
5. Start a match and confirm both clients can control their own snake.
6. Refresh one client and confirm slot reclaim still works.

## Tech Stack

- React
- Vite
- TypeScript
- Canvas
- Bun WebSockets
- Vitest
- Playwright

## Repo

GitHub: https://github.com/berkozero/snake-pvp
