# Repo Notes

- This project has two deploy targets.
- Railway hosts the authoritative Bun WebSocket server from `server/index.ts`.
- Vercel hosts the static Vite/React frontend built from `src/`.
- The frontend connects to the backend using `VITE_GAME_SERVER_URL`, which should point to the Railway `wss://.../ws` endpoint in production.
- For local development, use only two servers: backend on `3001` and frontend on `4173`.
- If either standard port is busy, stop the existing process on that port instead of starting alternate local ports.
