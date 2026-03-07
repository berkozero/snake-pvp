# Snake PVP

Repo layout is now split by deploy boundary:

- `apps/web`: Vercel-only React/Vite frontend
- `apps/server`: Railway-only Bun WebSocket server and checked-in PPO inference bundle
- `packages/game-core`: runtime-safe shared gameplay core, protocol, and deterministic simulator
- `tools/ai`: local-only training workspace with `scripts/`, `configs/`, `python/`, and ignored `.local/` outputs

Only `@snake/game-core` is allowed to cross between deploy apps.

## Local Development

Install once from the repo root:

```bash
bun install
cp .env.example .env
```

Run the standard local ports in two terminals:

```bash
bun run dev:server
bun run dev:web
```

- Server: `http://127.0.0.1:3001/health`
- Frontend: `http://127.0.0.1:4173`
- Default frontend socket: `ws://127.0.0.1:3001/ws`

To play against the AI locally, claim one slot, enable `Add AI` on the other slot, then start the match.

## Workspace Commands

```bash
bun run dev:server
bun run dev:web
bun run server
bun run build
bun run test
bun run e2e
bun run check:boundaries
bun run audit:web-dist
```

AI and training commands now live under `tools/ai` and are still exposed through the root:

```bash
bun run ai:dataset
bun run ai:train
bun run ai:eval
bun run ai:export-policy
bun run ai:gate
```

## Deploy Roots

Set deploy roots to the app directories directly:

- Vercel root directory: `apps/web`
- Railway root directory: `apps/server`

Production frontend environment:

```bash
VITE_GAME_SERVER_URL=wss://your-railway-domain/ws
```

The checked-in Railway-safe PPO bundle lives at [apps/server/src/ai/policies/ppo-ablation-a.best-policy.json](/Users/berkozer/Documents/snake-pvp/worktrees/simulator-extraction/apps/server/src/ai/policies/ppo-ablation-a.best-policy.json).

## Boundary Enforcement

The repo now includes:

- TS workspace/package boundaries around `apps/*`, `packages/*`, and `tools/*`
- [scripts/check-boundaries.mjs](/Users/berkozer/Documents/snake-pvp/worktrees/simulator-extraction/scripts/check-boundaries.mjs) to fail forbidden `apps/web -> apps/server|tools/ai` and `apps/server -> tools/ai` imports
- [scripts/audit-web-dist.mjs](/Users/berkozer/Documents/snake-pvp/worktrees/simulator-extraction/scripts/audit-web-dist.mjs) to fail if forbidden server or AI markers leak into the Vercel bundle

## Notes

- `tools/ai/.local/` holds local datasets, checkpoints, eval outputs, replays, and RL runs and is fully gitignored.
- `packages/game-core` now separates deterministic gameplay runtime from ML-facing helpers under `src/ml/`.
- `apps/server` keeps only live inference code plus the exported PPO JSON artifact needed at runtime.
