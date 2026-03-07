# Repo Notes

- This project has two deploy targets.
- Railway hosts the authoritative Bun WebSocket server from `apps/server/src/index.ts`.
- Vercel hosts the static Vite/React frontend built from `apps/web/src/`.
- Keep production deploys minimal: Vercel should contain only the frontend, and Railway should contain only the Bun server plus the tiny inference asset/runtime.
- Do not ship Python, training scripts, checkpoints, datasets, eval tooling, or other offline AI/training logic to Vercel or Railway.
- Training is local-only: train/export models offline, then copy only the small exported inference bundle needed by the Railway server.
- Production inference must use the exported lightweight runtime artifact, not the training stack.
- The frontend connects to the backend using `VITE_GAME_SERVER_URL`, which should point to the Railway `wss://.../ws` endpoint in production.
- For local development, use only two servers: backend on `3001` and frontend on `4173`.
- If either standard port is busy, stop the existing process on that port instead of starting alternate local ports.
