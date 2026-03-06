# Snake PVP

A fast local multiplayer Snake game built with React, Vite, TypeScript, and Canvas.

Two players share one keyboard, chase the same food, grow longer, cut each other's body, and fight for the highest score before the 3-minute timer ends.

## Gameplay

- Classic grid-based movement inspired by old-school Nokia Snake
- 2 local players on one keyboard
- 3-minute matches with live score tracking
- Eating food gives `+1` score and grows your snake
- Hitting your own body or a wall kills you
- Biting an enemy body segment cuts off the rest of their tail
- Longer snake wins head-on collisions; equal length knocks both out
- If score is tied at time up, current snake length is the tiebreaker

## Controls

- Player 1: `W`, `A`, `S`, `D`
- Player 2: `I`, `J`, `K`, `L`
- Pause: `Space`
- Start / Restart: `Enter`

## Visual Style

- Black arena and background
- Distinct snake colors for each player
- Bright food dot for easy tracking
- Retro arcade / Nokia-inspired presentation with modern UI polish

## Run Locally

```bash
bun install
bun run dev
```

The dev server runs locally and Vite will print the URL in the terminal.

## Scripts

```bash
bun run dev
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

## Tech Stack

- React
- Vite
- TypeScript
- Canvas
- Vitest
- Playwright

## Repo

GitHub: https://github.com/berkozero/snake-pvp
