import type { Cell, Direction, PlayerId, PlayerState, RoundState } from './types';

export const BOARD_WIDTH = 36;
export const BOARD_HEIGHT = 24;
export const CELL_SIZE = 22;
export const MATCH_DURATION_MS = 180_000;
export const COUNTDOWN_MS = 2_400;
export const RESPAWN_DELAY_MS = 3_000;
export const START_LENGTH = 4;
export const TICK_MS = 100;
export const PAUSE_KEY = ' ';

const PLAYER_CONFIG: Record<PlayerId, Pick<PlayerState, 'name' | 'color' | 'glow' | 'keyMap'>> = {
  p1: {
    name: 'P1',
    color: '#7cff7a',
    glow: 'rgba(124, 255, 122, 0.24)',
    keyMap: {
      w: 'up',
      a: 'left',
      s: 'down',
      d: 'right',
    },
  },
  p2: {
    name: 'P2',
    color: '#56a8ff',
    glow: 'rgba(86, 168, 255, 0.28)',
    keyMap: {
      i: 'up',
      j: 'left',
      k: 'down',
      l: 'right',
    },
  },
};

const START_LAYOUTS: Record<PlayerId, { head: Cell; direction: Direction }> = {
  p1: {
    head: { x: 8, y: Math.floor(BOARD_HEIGHT / 2) },
    direction: 'right',
  },
  p2: {
    head: { x: BOARD_WIDTH - 9, y: Math.floor(BOARD_HEIGHT / 2) },
    direction: 'left',
  },
};

export const directionVectors: Record<Direction, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const oppositeDirection: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

export function makeStartingSnake(playerId: PlayerId): PlayerState {
  const config = PLAYER_CONFIG[playerId];
  const layout = START_LAYOUTS[playerId];
  const vector = directionVectors[oppositeDirection[layout.direction]];
  const segments = Array.from({ length: START_LENGTH }, (_, index) => ({
    x: layout.head.x + vector.x * index,
    y: layout.head.y + vector.y * index,
  }));

  return {
    id: playerId,
    name: config.name,
    score: 0,
    segments,
    direction: layout.direction,
    pendingDirection: layout.direction,
    alive: true,
    respawnAt: null,
    color: config.color,
    glow: config.glow,
    keyMap: config.keyMap,
  };
}

export function createInitialState(randomFood: Cell): RoundState {
  return {
    phase: 'menu',
    board: { width: BOARD_WIDTH, height: BOARD_HEIGHT },
    clockMs: 0,
    players: {
      p1: makeStartingSnake('p1'),
      p2: makeStartingSnake('p2'),
    },
    food: randomFood,
    remainingMs: MATCH_DURATION_MS,
    winner: null,
    countdownMs: COUNTDOWN_MS,
    tickMs: TICK_MS,
    paused: false,
  };
}
