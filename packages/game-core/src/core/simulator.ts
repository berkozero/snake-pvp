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
} from '../constants';
import type { Cell, Direction, PlayerId, PlayerState, RespawnPreview, RoundState, TickResult } from '../types';

const PLAYER_IDS: PlayerId[] = ['p1', 'p2'];
const FOOD_EDGE_BUFFER = 3;
const FOOD_EDGE_WEIGHT = 0.55;

export type RandomSource = () => number;
export type RandomSourceFactory = () => RandomSource;

export type SimulatorOptions = {
  random?: RandomSource;
  randomFactory?: RandomSourceFactory;
  shouldMove?: boolean;
};

export type CreateStateOverrides = Partial<Omit<RoundState, 'players' | 'board'>> & {
  players?: Partial<Record<PlayerId, Partial<PlayerState>>>;
};

export type SimulatorPlayerSnapshot = {
  alive: boolean;
  score: number;
  direction: Direction;
  pendingDirection: Direction;
  length: number;
  segments: Cell[];
  head: Cell | null;
  respawnRemainingMs: number;
  respawnCountdown: number | null;
  respawnPreview: RespawnPreview | null;
};

export type SimulatorSnapshot = {
  phase: RoundState['phase'];
  board: RoundState['board'];
  clockMs: number;
  countdownMs: number;
  remainingMs: number;
  winner: RoundState['winner'];
  food: Cell;
  players: Record<PlayerId, SimulatorPlayerSnapshot>;
};

export type ReplayAction = {
  atMs: number;
  playerId: PlayerId;
  direction: Direction;
};

export type ReplayScript = {
  seed: number;
  actions: ReplayAction[];
  endAtMs: number;
};

export type ReplayFrame = {
  reason: 'initial' | 'time_advanced' | 'action_applied' | 'movement_step';
  action?: ReplayAction;
  snapshot: SimulatorSnapshot;
};

export type SimulatorAdvanceResult = {
  didAdvanceBoard: boolean;
  movementSteps: number;
  snapshots: ReplayFrame[];
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

export function canUseDirection(current: Direction, next: Direction): boolean {
  return oppositeDirection[current] !== next;
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

export function createGameState(options: SimulatorOptions = {}): RoundState {
  const random = options.random ?? Math.random;
  const seedPlayers = {
    p1: makeStartingSnake('p1'),
    p2: makeStartingSnake('p2'),
  };
  return createInitialState(pickFoodCell(seedPlayers, random));
}

export function restartGame(options: SimulatorOptions = {}): RoundState {
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

export function applyDirection(state: RoundState, playerId: PlayerId, direction: Direction): RoundState {
  const player = state.players[playerId];
  if (!canUseDirection(player.direction, direction)) {
    return state;
  }

  return {
    ...state,
    players: {
      ...state.players,
      [playerId]: { ...player, pendingDirection: direction },
    },
  };
}

type MoveData = {
  nextPlayer: PlayerState;
  head: Cell;
  ateFood: boolean;
};

export function tick(state: RoundState, deltaMs: number, _nowMs: number, options: SimulatorOptions = {}): TickResult {
  const random = options.random ?? Math.random;
  const shouldMove = options.shouldMove ?? true;

  if (state.phase === 'menu' || state.phase === 'finished' || state.phase === 'paused') {
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

  return {
    state: {
      ...workingState,
      players: playersAfterMove,
      food: nextFood,
      winner: null,
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

export function createDeterministicRandomFactory(values: number[]): RandomSourceFactory {
  return () => createDeterministicRandom(values);
}

export function createSeededRandom(seed: number): RandomSource {
  let state = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSeededRandomFactory(seed: number): RandomSourceFactory {
  return () => createSeededRandom(seed);
}

export function createTestState(overrides: CreateStateOverrides = {}, options: SimulatorOptions = {}): RoundState {
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

export function createSimulatorSnapshot(state: RoundState): SimulatorSnapshot {
  return {
    phase: state.phase,
    board: { ...state.board },
    clockMs: state.clockMs,
    countdownMs: state.countdownMs,
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
            segments: cloneSegments(player.segments),
            head: player.segments[0] ? cloneCell(player.segments[0]) : null,
            respawnRemainingMs: getRespawnRemainingMs(player, state.clockMs),
            respawnCountdown: getRespawnCountdown(player, state.clockMs),
            respawnPreview: cloneRespawnPreview(player.respawnPreview),
          },
        ];
      }),
    ) as Record<PlayerId, SimulatorPlayerSnapshot>,
  };
}

export class SnakeSimulator {
  private readonly createRandom: RandomSourceFactory;
  private random: RandomSource;
  private state: RoundState;
  private movementAccumulatorMs = 0;

  constructor(options: SimulatorOptions = {}) {
    this.createRandom = options.randomFactory ?? (() => options.random ?? Math.random);
    this.random = this.createRandom();
    this.state = createGameState({ random: this.random });
  }

  getState(): RoundState {
    return this.state;
  }

  reset(): RoundState {
    this.random = this.createRandom();
    this.state = createGameState({ random: this.random });
    this.movementAccumulatorMs = 0;
    return this.state;
  }

  startCountdown(): RoundState {
    this.state = startCountdown(this.state);
    this.movementAccumulatorMs = 0;
    return this.state;
  }

  submitAction(playerId: PlayerId, direction: Direction): RoundState {
    this.state = applyDirection(this.state, playerId, direction);
    return this.state;
  }

  advanceTime(deltaMs: number): TickResult {
    const result = tick(this.state, deltaMs, this.state.clockMs + deltaMs, {
      random: this.random,
      shouldMove: false,
    });
    this.state = result.state;
    return result;
  }

  stepMovement(): TickResult {
    const result = tick(this.state, 0, this.state.clockMs, {
      random: this.random,
      shouldMove: true,
    });
    this.state = result.state;
    return result;
  }

  snapshot(): SimulatorSnapshot {
    return createSimulatorSnapshot(this.state);
  }

  advanceElapsed(deltaMs: number): SimulatorAdvanceResult {
    if (deltaMs <= 0 || this.state.phase === 'finished' || this.state.phase === 'menu' || this.state.phase === 'paused') {
      return { didAdvanceBoard: false, movementSteps: 0, snapshots: [] };
    }

    const snapshots: ReplayFrame[] = [];
    let remainingElapsedMs = deltaMs;
    let didAdvanceBoard = false;
    let movementSteps = 0;

    if (this.state.phase === 'countdown' && this.state.countdownMs > 0) {
      const countdownStepMs = Math.min(remainingElapsedMs, this.state.countdownMs);
      const countdownResult = this.advanceTime(countdownStepMs);
      snapshots.push({ reason: 'time_advanced', snapshot: this.snapshot() });
      didAdvanceBoard = didAdvanceBoard || countdownResult.didAdvanceBoard;
      remainingElapsedMs -= countdownStepMs;
      this.movementAccumulatorMs = 0;
    }

    if (remainingElapsedMs > 0 && this.state.phase === 'playing') {
      const timerResult = this.advanceTime(remainingElapsedMs);
      snapshots.push({ reason: 'time_advanced', snapshot: this.snapshot() });
      didAdvanceBoard = didAdvanceBoard || timerResult.didAdvanceBoard;
      this.movementAccumulatorMs += remainingElapsedMs;
    }

    while (this.state.phase === 'playing' && this.movementAccumulatorMs >= this.state.movementMs) {
      const moveResult = this.stepMovement();
      snapshots.push({ reason: 'movement_step', snapshot: this.snapshot() });
      didAdvanceBoard = didAdvanceBoard || moveResult.didAdvanceBoard;
      this.movementAccumulatorMs -= this.state.movementMs;
      movementSteps += 1;
    }

    return {
      didAdvanceBoard,
      movementSteps,
      snapshots,
    };
  }
}

export function runReplay(script: ReplayScript): SimulatorSnapshot[] {
  return runReplayFrames(script).map((frame) => frame.snapshot);
}

export function runReplayFrames(script: ReplayScript): ReplayFrame[] {
  const simulator = new SnakeSimulator({ randomFactory: createSeededRandomFactory(script.seed) });
  simulator.startCountdown();

  const frames: ReplayFrame[] = [{ reason: 'initial', snapshot: simulator.snapshot() }];
  let actionIndex = 0;

  while (simulator.getState().clockMs < script.endAtMs && simulator.getState().phase !== 'finished') {
    const targetTime = Math.min(simulator.getState().clockMs + simulator.getState().tickMs, script.endAtMs);
    while (actionIndex < script.actions.length && script.actions[actionIndex].atMs <= targetTime) {
      const action = script.actions[actionIndex];
      if (action.atMs > simulator.getState().clockMs) {
        frames.push(...simulator.advanceElapsed(action.atMs - simulator.getState().clockMs).snapshots);
      }
      simulator.submitAction(action.playerId, action.direction);
      frames.push({ reason: 'action_applied', action, snapshot: simulator.snapshot() });
      actionIndex += 1;
    }

    if (simulator.getState().clockMs < targetTime) {
      frames.push(...simulator.advanceElapsed(targetTime - simulator.getState().clockMs).snapshots);
    }
  }

  return frames;
}
