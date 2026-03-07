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
import type { Cell, Direction, PlayerId, PlayerState, RespawnPreview, RoundState, TickResult } from './types';

const PLAYER_IDS: PlayerId[] = ['p1', 'p2'];
const FOOD_EDGE_BUFFER = 3;
const FOOD_EDGE_WEIGHT = 0.55;

type RandomSource = () => number;

type GameRuntimeOptions = {
  random?: RandomSource;
  shouldMove?: boolean;
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

function cloneRespawnPreview(preview: RespawnPreview | null): RespawnPreview | null {
  if (!preview) {
    return null;
  }

  return {
    head: cloneCell(preview.head),
    direction: preview.direction,
  };
}

function clonePlayer(player: PlayerState): PlayerState {
  return {
    ...player,
    segments: cloneSegments(player.segments),
    respawnPreview: cloneRespawnPreview(player.respawnPreview),
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

function buildSpawnSegments(head: Cell, direction: Direction): Cell[] {
  const tailVector = directionVectors[oppositeDirection[direction]];
  return Array.from({ length: START_LENGTH }, (_, index) => ({
    x: head.x + tailVector.x * index,
    y: head.y + tailVector.y * index,
  }));
}

function pickRandomIndex(length: number, random: RandomSource): number {
  return Math.floor(random() * length);
}

function weightedRandomIndex(weights: number[], random: RandomSource): number {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return 0;
  }

  let threshold = random() * totalWeight;
  for (let index = 0; index < weights.length; index += 1) {
    threshold -= weights[index];
    if (threshold < 0) {
      return index;
    }
  }

  return weights.length - 1;
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
    const segments = buildSpawnSegments(candidate.head, candidate.direction);
    if (segments.every((cell) => isInsideBoard(cell) && !occupied.has(cellKey(cell)))) {
      return { segments, direction: candidate.direction };
    }
  }

  return {
    segments: buildSpawnSegments({ x: Math.floor(BOARD_WIDTH / 2), y: Math.floor(BOARD_HEIGHT / 2) }, 'right'),
    direction: 'right',
  };
}

export function pickFoodCell(players: Record<PlayerId, PlayerState>, random: RandomSource): Cell {
  const occupied = new Set<string>();
  for (const player of PLAYER_IDS.map((id) => players[id])) {
    for (const segment of player.segments) {
      occupied.add(cellKey(segment));
    }
  }

  const free: Cell[] = [];
  const weights: number[] = [];
  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      const cell = { x, y };
      if (!occupied.has(cellKey(cell))) {
        free.push(cell);
        const distanceToBorder = Math.min(x, y, BOARD_WIDTH - 1 - x, BOARD_HEIGHT - 1 - y);
        weights.push(distanceToBorder < FOOD_EDGE_BUFFER ? FOOD_EDGE_WEIGHT : 1);
      }
    }
  }

  return free[weightedRandomIndex(weights, random)] ?? {
    x: Math.floor(BOARD_WIDTH / 2),
    y: Math.floor(BOARD_HEIGHT / 2),
  };
}

function pickRespawnPreview(occupied: Set<string>, random: RandomSource): RespawnPreview {
  const spawn = findSafeSpawn(occupied, random);
  return {
    head: cloneCell(spawn.segments[0]),
    direction: spawn.direction,
  };
}

function makeRespawnedPlayer(player: PlayerState, occupied: Set<string>, random: RandomSource): PlayerState {
  const preview = player.respawnPreview ?? pickRespawnPreview(occupied, random);
  const segments = buildSpawnSegments(preview.head, preview.direction);
  return {
    ...player,
    segments,
    direction: preview.direction,
    pendingDirection: preview.direction,
    alive: true,
    respawnAt: null,
    respawnPreview: null,
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

function killPlayer(player: PlayerState, nowMs: number, preview: RespawnPreview): PlayerState {
  return {
    ...player,
    alive: false,
    segments: [],
    respawnAt: nowMs + RESPAWN_DELAY_MS,
    respawnPreview: cloneRespawnPreview(preview),
  };
}

export function getRespawnRemainingMs(player: PlayerState, nowMs: number): number {
  if (player.alive || player.respawnAt === null) {
    return 0;
  }
  return Math.max(0, player.respawnAt - nowMs);
}

export function getRespawnCountdown(player: PlayerState, nowMs: number): number | null {
  const remainingMs = getRespawnRemainingMs(player, nowMs);
  if (remainingMs <= 0) {
    return null;
  }
  return Math.ceil(remainingMs / 1000);
}

export function createGameState(options: GameRuntimeOptions = {}): RoundState {
  const random = options.random ?? Math.random;
  const seedPlayers = {
    p1: makeStartingSnake('p1'),
    p2: makeStartingSnake('p2'),
  };
  return createInitialState(pickFoodCell(seedPlayers, random));
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

export function tick(state: RoundState, deltaMs: number, _nowMs: number, options: GameRuntimeOptions = {}): TickResult {
  const random = options.random ?? Math.random;
  const shouldMove = options.shouldMove ?? true;

  if (state.phase === 'menu' || state.phase === 'finished') {
    return { state, events: [], didAdvanceBoard: false };
  }

  if (state.phase === 'paused') {
    return { state, events: [], didAdvanceBoard: false };
  }

  if (state.phase === 'countdown') {
    const countdownMs = Math.max(0, state.countdownMs - deltaMs);
    if (countdownMs === 0) {
      return {
        state: { ...state, phase: 'playing', countdownMs: 0, clockMs: state.clockMs + deltaMs },
        events: ['countdown-complete'],
        didAdvanceBoard: false,
      };
    }
    return { state: { ...state, countdownMs, clockMs: state.clockMs + deltaMs }, events: [], didAdvanceBoard: false };
  }

  const workingState: RoundState = {
    ...state,
    clockMs: state.clockMs + deltaMs,
    remainingMs: Math.max(0, state.remainingMs - deltaMs),
    players: { ...state.players },
  };
  const events: string[] = [];
  const respawnedIds = new Set<PlayerId>();
  let didAdvanceBoard = false;

  const respawnOccupied = new Set<string>();
  for (const id of PLAYER_IDS) {
    for (const segment of workingState.players[id].segments) {
      respawnOccupied.add(cellKey(segment));
    }
  }

  for (const id of PLAYER_IDS) {
    const player = workingState.players[id];
    if (!player.alive && player.respawnAt !== null && workingState.clockMs >= player.respawnAt) {
      workingState.players[id] = makeRespawnedPlayer(player, respawnOccupied, random);
      for (const segment of workingState.players[id].segments) {
        respawnOccupied.add(cellKey(segment));
      }
      respawnedIds.add(id);
      events.push(`${id}-respawn`);
      didAdvanceBoard = true;
    }
  }

  if (workingState.remainingMs === 0) {
    return {
      state: {
        ...workingState,
        phase: 'finished',
        winner: finalizeWinner(workingState.players),
      },
      events,
      didAdvanceBoard,
    };
  }

  if (!shouldMove) {
    return {
      state: workingState,
      events,
      didAdvanceBoard,
    };
  }

  const aliveIds = PLAYER_IDS.filter((id) => workingState.players[id].alive);
  const movingAliveIds = aliveIds.filter((id) => !respawnedIds.has(id));
  const moved: Record<PlayerId, MoveData | null> = { p1: null, p2: null };
  const foodCell = workingState.food;

  for (const id of movingAliveIds) {
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
  didAdvanceBoard = didAdvanceBoard || movingAliveIds.length > 0;

  const playersAfterMove = { ...workingState.players };
  for (const id of movingAliveIds) {
    playersAfterMove[id] = moved[id]!.nextPlayer;
    if (moved[id]!.ateFood) {
      events.push(`${id}-food`);
    }
  }

  const neckDeaths = new Set<PlayerId>();

  for (const attackerId of movingAliveIds) {
    const defenderId = attackerId === 'p1' ? 'p2' : 'p1';
    const attackerHead = moved[attackerId]?.head;
    const defender = playersAfterMove[defenderId];
    if (!attackerHead || !defender.alive) {
      continue;
    }

    const hitIndex = defender.segments.findIndex((segment) => cellsEqual(segment, attackerHead));
    if (hitIndex === 1) {
      neckDeaths.add(defenderId);
      continue;
    }
    if (hitIndex >= 2) {
      playersAfterMove[defenderId] = {
        ...defender,
        segments: defender.segments.slice(0, hitIndex + 1),
      };
      events.push(`${attackerId}-cut-${defenderId}`);
    }
  }

  const deaths = new Set<PlayerId>(neckDeaths);

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
  }

  if (playersAfterMove.p1.alive && playersAfterMove.p2.alive) {
    const p1Head = playersAfterMove.p1.segments[0];
    const p2Head = playersAfterMove.p2.segments[0];
    if (cellsEqual(p1Head, p2Head)) {
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

  for (const id of deaths) {
    const occupied = new Set<string>();
    for (const playerId of PLAYER_IDS) {
      if (playerId === id || deaths.has(playerId)) {
        continue;
      }
      for (const segment of playersAfterMove[playerId].segments) {
        occupied.add(cellKey(segment));
      }
    }
    for (const priorId of PLAYER_IDS) {
      if (priorId === id) {
        break;
      }
      const priorPreview = playersAfterMove[priorId].respawnPreview;
      if (!deaths.has(priorId) || !priorPreview) {
        continue;
      }
      for (const segment of buildSpawnSegments(priorPreview.head, priorPreview.direction)) {
        occupied.add(cellKey(segment));
      }
    }

    const preview = pickRespawnPreview(occupied, random);
    playersAfterMove[id] = killPlayer(playersAfterMove[id], workingState.clockMs, preview);
    events.push(`${id}-death`);
  }

  let nextFood = workingState.food;
  if (movingAliveIds.some((id) => moved[id]?.ateFood)) {
    nextFood = pickFoodCell(playersAfterMove, random);
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
    didAdvanceBoard,
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
    clockMs: state.clockMs,
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
            respawnRemainingMs: getRespawnRemainingMs(player, state.clockMs),
            respawnCountdown: getRespawnCountdown(player, state.clockMs),
            direction: player.direction,
            pendingDirection: player.pendingDirection,
            length: player.segments.length,
            head: player.segments[0] ? cloneCell(player.segments[0]) : null,
            respawnPreview: cloneRespawnPreview(player.respawnPreview),
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
  return `${Math.ceil(ms / 1000)}`;
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
