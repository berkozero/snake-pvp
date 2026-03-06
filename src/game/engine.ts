import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  COUNTDOWN_MS,
  MATCH_DURATION_MS,
  RESPAWN_DELAY_MS,
  START_LENGTH,
  createInitialState,
  directionVectors,
  makeStartingSnake,
  oppositeDirection,
} from './constants';
import type { Cell, Direction, PlayerId, PlayerState, RoundState, TickResult } from './types';

const PLAYER_IDS: PlayerId[] = ['p1', 'p2'];

type RandomSource = () => number;

type GameRuntimeOptions = {
  random?: RandomSource;
};

type CreateStateOverrides = Partial<Omit<RoundState, 'players' | 'board'>> & {
  players?: Partial<Record<PlayerId, Partial<PlayerState>>>;
};

function cloneCell(cell: Cell): Cell {
  return { ...cell };
}

function cloneSegments(segments: Cell[]): Cell[] {
  return segments.map(cloneCell);
}

function clonePlayer(player: PlayerState): PlayerState {
  return {
    ...player,
    segments: cloneSegments(player.segments),
    keyMap: { ...player.keyMap },
  };
}

function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

function cellsEqual(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

function isInsideBoard(cell: Cell): boolean {
  return cell.x >= 0 && cell.y >= 0 && cell.x < BOARD_WIDTH && cell.y < BOARD_HEIGHT;
}

function advanceHead(cell: Cell, direction: Direction): Cell {
  const vector = directionVectors[direction];
  return { x: cell.x + vector.x, y: cell.y + vector.y };
}

function pickRandomIndex(length: number, random: RandomSource): number {
  return Math.floor(random() * length);
}

function shuffle<T>(values: T[], random: RandomSource): T[] {
  const array = [...values];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = pickRandomIndex(i + 1, random);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function findSafeSpawn(occupied: Set<string>, random: RandomSource): { segments: Cell[]; direction: Direction } {
  const candidates: Array<{ head: Cell; direction: Direction }> = [];
  for (let y = 2; y < BOARD_HEIGHT - 2; y += 1) {
    for (let x = 2; x < BOARD_WIDTH - 2; x += 1) {
      candidates.push({ head: { x, y }, direction: 'right' });
      candidates.push({ head: { x, y }, direction: 'left' });
      candidates.push({ head: { x, y }, direction: 'up' });
      candidates.push({ head: { x, y }, direction: 'down' });
    }
  }

  for (const candidate of shuffle(candidates, random)) {
    const tailVector = directionVectors[oppositeDirection[candidate.direction]];
    const segments = Array.from({ length: START_LENGTH }, (_, index) => ({
      x: candidate.head.x + tailVector.x * index,
      y: candidate.head.y + tailVector.y * index,
    }));
    if (segments.every((cell) => isInsideBoard(cell) && !occupied.has(cellKey(cell)))) {
      return { segments, direction: candidate.direction };
    }
  }

  return {
    segments: [{ x: Math.floor(BOARD_WIDTH / 2), y: Math.floor(BOARD_HEIGHT / 2) }],
    direction: 'right',
  };
}

function randomFreeCell(players: Record<PlayerId, PlayerState>, random: RandomSource): Cell {
  const occupied = new Set<string>();
  for (const player of PLAYER_IDS.map((id) => players[id])) {
    for (const segment of player.segments) {
      occupied.add(cellKey(segment));
    }
  }

  const free: Cell[] = [];
  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      const cell = { x, y };
      if (!occupied.has(cellKey(cell))) {
        free.push(cell);
      }
    }
  }

  return free[pickRandomIndex(free.length, random)] ?? { x: Math.floor(BOARD_WIDTH / 2), y: Math.floor(BOARD_HEIGHT / 2) };
}

function makeRespawnedPlayer(player: PlayerState, occupied: Set<string>, random: RandomSource): PlayerState {
  const spawn = findSafeSpawn(occupied, random);
  return {
    ...player,
    segments: spawn.segments,
    direction: spawn.direction,
    pendingDirection: spawn.direction,
    alive: true,
    respawnAt: null,
  };
}

function finalizeWinner(players: Record<PlayerId, PlayerState>): PlayerId | 'draw' {
  const [p1, p2] = PLAYER_IDS.map((id) => players[id]);
  if (p1.score !== p2.score) {
    return p1.score > p2.score ? 'p1' : 'p2';
  }
  if (p1.segments.length !== p2.segments.length) {
    return p1.segments.length > p2.segments.length ? 'p1' : 'p2';
  }
  return 'draw';
}

function canUseDirection(current: Direction, next: Direction): boolean {
  return oppositeDirection[current] !== next;
}

function killPlayer(player: PlayerState, nowMs: number): PlayerState {
  return {
    ...player,
    alive: false,
    segments: [],
    respawnAt: nowMs + RESPAWN_DELAY_MS,
  };
}

export function createGameState(options: GameRuntimeOptions = {}): RoundState {
  const random = options.random ?? Math.random;
  const seedPlayers = {
    p1: makeStartingSnake('p1'),
    p2: makeStartingSnake('p2'),
  };
  return createInitialState(randomFreeCell(seedPlayers, random));
}

export function restartGame(options: GameRuntimeOptions = {}): RoundState {
  return createGameState(options);
}

export function startCountdown(state: RoundState): RoundState {
  return {
    ...state,
    phase: 'countdown',
    countdownMs: COUNTDOWN_MS,
    remainingMs: MATCH_DURATION_MS,
    winner: null,
    paused: false,
  };
}

export function togglePause(state: RoundState): RoundState {
  if (state.phase !== 'playing' && state.phase !== 'paused') {
    return state;
  }

  return {
    ...state,
    phase: state.phase === 'paused' ? 'playing' : 'paused',
  };
}

export function queueDirection(state: RoundState, key: string): RoundState {
  const normalized = key.toLowerCase();
  let changed = false;
  const players = Object.fromEntries(
    PLAYER_IDS.map((id) => {
      const player = state.players[id];
      const requested = player.keyMap[normalized];
      if (!requested) {
        return [id, player];
      }

      if (canUseDirection(player.direction, requested)) {
        changed = true;
        return [id, { ...player, pendingDirection: requested }];
      }

      return [id, player];
    }),
  ) as Record<PlayerId, PlayerState>;

  return changed ? { ...state, players } : state;
}

type MoveData = {
  nextPlayer: PlayerState;
  head: Cell;
  ateFood: boolean;
};

export function tick(state: RoundState, deltaMs: number, nowMs: number, options: GameRuntimeOptions = {}): TickResult {
  const random = options.random ?? Math.random;

  if (state.phase === 'menu' || state.phase === 'finished') {
    return { state, events: [] };
  }

  if (state.phase === 'paused') {
    return { state, events: [] };
  }

  if (state.phase === 'countdown') {
    const countdownMs = Math.max(0, state.countdownMs - deltaMs);
    if (countdownMs === 0) {
      return { state: { ...state, phase: 'playing', countdownMs: 0 }, events: ['countdown-complete'] };
    }
    return { state: { ...state, countdownMs }, events: [] };
  }

  const workingState: RoundState = {
    ...state,
    remainingMs: Math.max(0, state.remainingMs - deltaMs),
    players: { ...state.players },
  };
  const events: string[] = [];

  const respawnOccupied = new Set<string>();
  for (const id of PLAYER_IDS) {
    for (const segment of workingState.players[id].segments) {
      respawnOccupied.add(cellKey(segment));
    }
  }

  for (const id of PLAYER_IDS) {
    const player = workingState.players[id];
    if (!player.alive && player.respawnAt !== null && nowMs >= player.respawnAt) {
      workingState.players[id] = makeRespawnedPlayer(player, respawnOccupied, random);
      for (const segment of workingState.players[id].segments) {
        respawnOccupied.add(cellKey(segment));
      }
      events.push(`${id}-respawn`);
    }
  }

  const aliveIds = PLAYER_IDS.filter((id) => workingState.players[id].alive);
  const moved: Record<PlayerId, MoveData | null> = { p1: null, p2: null };
  const foodCell = workingState.food;

  for (const id of aliveIds) {
    const player = workingState.players[id];
    const direction = canUseDirection(player.direction, player.pendingDirection)
      ? player.pendingDirection
      : player.direction;
    const head = advanceHead(player.segments[0], direction);
    const ateFood = cellsEqual(head, foodCell);
    const nextSegments = [head, ...cloneSegments(player.segments)];
    if (!ateFood) {
      nextSegments.pop();
    }

    moved[id] = {
      head,
      ateFood,
      nextPlayer: {
        ...player,
        direction,
        pendingDirection: direction,
        segments: nextSegments,
        score: player.score + (ateFood ? 1 : 0),
      },
    };
  }

  const playersAfterMove = { ...workingState.players };
  for (const id of aliveIds) {
    playersAfterMove[id] = moved[id]!.nextPlayer;
    if (moved[id]!.ateFood) {
      events.push(`${id}-food`);
    }
  }

  const cutExemptions = new Map<PlayerId, Set<string>>();
  for (const id of PLAYER_IDS) {
    cutExemptions.set(id, new Set<string>());
  }

  for (const attackerId of aliveIds) {
    const defenderId = attackerId === 'p1' ? 'p2' : 'p1';
    const attackerHead = moved[attackerId]?.head;
    const defender = playersAfterMove[defenderId];
    if (!attackerHead || !defender.alive) {
      continue;
    }

    const hitIndex = defender.segments.findIndex((segment, index) => index >= 2 && cellsEqual(segment, attackerHead));
    if (hitIndex >= 2) {
      cutExemptions.get(attackerId)!.add(cellKey(attackerHead));
      playersAfterMove[defenderId] = {
        ...defender,
        segments: defender.segments.slice(0, hitIndex + 1),
      };
      events.push(`${attackerId}-cut-${defenderId}`);
    }
  }

  const deaths = new Set<PlayerId>();

  for (const id of aliveIds) {
    const player = playersAfterMove[id];
    const head = player.segments[0];
    if (!isInsideBoard(head)) {
      deaths.add(id);
      continue;
    }

    if (player.segments.slice(1).some((segment) => cellsEqual(segment, head))) {
      deaths.add(id);
      continue;
    }

    const otherId = id === 'p1' ? 'p2' : 'p1';
    const other = playersAfterMove[otherId];
    const exempt = cutExemptions.get(id)!;
    const sharedFoodHead =
      moved[id]?.ateFood &&
      moved[otherId]?.ateFood &&
      cellsEqual(head, workingState.food) &&
      cellsEqual(other.segments[0], head);
    const hitEnemy = other.segments.some(
      (segment, index) =>
        cellsEqual(segment, head) &&
        !exempt.has(cellKey(segment)) &&
        !(sharedFoodHead && index === 0),
    );
    if (hitEnemy) {
      deaths.add(id);
    }
  }

  if (playersAfterMove.p1.alive && playersAfterMove.p2.alive) {
    const p1Head = playersAfterMove.p1.segments[0];
    const p2Head = playersAfterMove.p2.segments[0];
    if (cellsEqual(p1Head, p2Head)) {
      const contestedFood = moved.p1?.ateFood && moved.p2?.ateFood && cellsEqual(p1Head, workingState.food);
      if (!contestedFood) {
        const p1Length = playersAfterMove.p1.segments.length;
        const p2Length = playersAfterMove.p2.segments.length;
        if (p1Length === p2Length) {
          deaths.add('p1');
          deaths.add('p2');
        } else if (p1Length > p2Length) {
          deaths.add('p2');
          deaths.delete('p1');
        } else {
          deaths.add('p1');
          deaths.delete('p2');
        }
      }
    }
  }

  for (const id of deaths) {
    playersAfterMove[id] = killPlayer(playersAfterMove[id], nowMs);
    events.push(`${id}-death`);
  }

  let nextFood = workingState.food;
  if (aliveIds.some((id) => moved[id]?.ateFood)) {
    nextFood = randomFreeCell(playersAfterMove, random);
  }

  let nextPhase = workingState.phase;
  let winner: RoundState['winner'] = null;
  if (workingState.remainingMs === 0) {
    nextPhase = 'finished';
    winner = finalizeWinner(playersAfterMove);
  }

  return {
    state: {
      ...workingState,
      phase: nextPhase,
      players: playersAfterMove,
      food: nextFood,
      winner,
    },
    events,
  };
}

export function createDeterministicRandom(values: number[]): RandomSource {
  let index = 0;
  return () => {
    if (values.length === 0) {
      return 0;
    }
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

export function createTestState(overrides: CreateStateOverrides = {}, options: GameRuntimeOptions = {}): RoundState {
  const base = createGameState(options);
  const players = Object.fromEntries(
    PLAYER_IDS.map((id) => {
      const playerOverrides = overrides.players?.[id] ?? {};
      return [
        id,
        {
          ...clonePlayer(base.players[id]),
          ...playerOverrides,
          segments: playerOverrides.segments ? cloneSegments(playerOverrides.segments) : cloneSegments(base.players[id].segments),
          keyMap: { ...base.players[id].keyMap, ...(playerOverrides.keyMap ?? {}) },
        },
      ];
    }),
  ) as Record<PlayerId, PlayerState>;

  return {
    ...base,
    ...overrides,
    board: { ...base.board },
    food: overrides.food ? cloneCell(overrides.food) : cloneCell(base.food),
    players,
  };
}

export function serializeState(state: RoundState) {
  return {
    phase: state.phase,
    remainingMs: state.remainingMs,
    winner: state.winner,
    food: cloneCell(state.food),
    players: Object.fromEntries(
      PLAYER_IDS.map((id) => {
        const player = state.players[id];
        return [
          id,
          {
            alive: player.alive,
            score: player.score,
            direction: player.direction,
            pendingDirection: player.pendingDirection,
            length: player.segments.length,
            head: player.segments[0] ? cloneCell(player.segments[0]) : null,
          },
        ];
      }),
    ),
  };
}

export function getCountdownLabel(state: RoundState): string | null {
  if (state.phase !== 'countdown') {
    return null;
  }
  return `${Math.max(1, Math.ceil(state.countdownMs / 800))}`;
}

export function formatTime(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function getWinnerLabel(state: RoundState): string {
  if (state.winner === 'draw') {
    return 'Draw Game';
  }
  if (state.winner) {
    return `${state.players[state.winner].name} Wins`;
  }
  return 'Match Over';
}
