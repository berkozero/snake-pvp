export type Cell = {
  x: number;
  y: number;
};

export type Direction = 'up' | 'down' | 'left' | 'right';

export type PlayerId = 'p1' | 'p2';

export type MatchPhase = 'menu' | 'countdown' | 'playing' | 'paused' | 'finished';

export type PlayerState = {
  id: PlayerId;
  name: string;
  score: number;
  segments: Cell[];
  direction: Direction;
  pendingDirection: Direction;
  alive: boolean;
  respawnAt: number | null;
  color: string;
  glow: string;
  keyMap: Record<string, Direction>;
};

export type RoundState = {
  phase: MatchPhase;
  board: {
    width: number;
    height: number;
  };
  clockMs: number;
  players: Record<PlayerId, PlayerState>;
  food: Cell;
  remainingMs: number;
  winner: PlayerId | 'draw' | null;
  countdownMs: number;
  tickMs: number;
  paused: boolean;
};

export type TickResult = {
  state: RoundState;
  events: string[];
};
