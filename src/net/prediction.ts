import type { Cell, Direction, PlayerId } from '../game/types';
import type { RoomPhase, RoomSnapshotMessage } from './protocol';

export type PendingInput = {
  inputSeq: number;
  direction: Direction;
  clientTime: number;
};

export type PredictedPlayerState = {
  playerId: PlayerId;
  alive: boolean;
  direction: Direction;
  pendingDirection: Direction;
  previousSegments: Cell[];
  currentSegments: Cell[];
  lastStepAt: number;
  tickMs: number;
};

function cloneSegments(segments: Cell[]): Cell[] {
  return segments.map((segment) => ({ ...segment }));
}

function canUseDirection(current: Direction, next: Direction): boolean {
  return !(
    (current === 'up' && next === 'down') ||
    (current === 'down' && next === 'up') ||
    (current === 'left' && next === 'right') ||
    (current === 'right' && next === 'left')
  );
}

function advanceCell(cell: Cell, direction: Direction): Cell {
  if (direction === 'up') {
    return { x: cell.x, y: cell.y - 1 };
  }
  if (direction === 'down') {
    return { x: cell.x, y: cell.y + 1 };
  }
  if (direction === 'left') {
    return { x: cell.x - 1, y: cell.y };
  }
  return { x: cell.x + 1, y: cell.y };
}

export function acknowledgePendingInputs(
  pendingInputs: PendingInput[],
  lastProcessedInputSeq: number | null,
): PendingInput[] {
  if (lastProcessedInputSeq === null) {
    return pendingInputs;
  }

  return pendingInputs.filter((input) => input.inputSeq > lastProcessedInputSeq);
}

export function createPredictedPlayerState(
  snapshot: RoomSnapshotMessage,
  pendingInputs: PendingInput[],
  receivedAt: number,
): PredictedPlayerState | null {
  if (!snapshot.yourSlot || !snapshot.game) {
    return null;
  }

  const player = snapshot.game.players[snapshot.yourSlot];
  const currentSegments = cloneSegments(player.segments);
  let pendingDirection = player.direction;

  for (const input of pendingInputs) {
    if (canUseDirection(player.direction, input.direction)) {
      pendingDirection = input.direction;
    }
  }

  return {
    playerId: snapshot.yourSlot,
    alive: player.alive,
    direction: player.direction,
    pendingDirection,
    previousSegments: currentSegments,
    currentSegments,
    lastStepAt: receivedAt,
    tickMs: snapshot.game.tickMs,
  };
}

export function applyPredictedInput(
  state: PredictedPlayerState | null,
  direction: Direction,
): PredictedPlayerState | null {
  if (!state || !state.alive) {
    return state;
  }

  if (canUseDirection(state.direction, direction)) {
    state.pendingDirection = direction;
  }

  return state;
}

export function advancePredictedPlayer(
  state: PredictedPlayerState | null,
  phase: RoomPhase,
  now: number,
): PredictedPlayerState | null {
  if (!state) {
    return null;
  }

  if (!state.alive || phase !== 'playing') {
    state.lastStepAt = now;
    return state;
  }

  while (now - state.lastStepAt >= state.tickMs) {
    const head = state.currentSegments[0];
    if (!head) {
      break;
    }

    const direction = canUseDirection(state.direction, state.pendingDirection)
      ? state.pendingDirection
      : state.direction;
    const nextHead = advanceCell(head, direction);
    state.previousSegments = cloneSegments(state.currentSegments);
    state.currentSegments = [nextHead, ...state.currentSegments.slice(0, -1).map((segment) => ({ ...segment }))];
    state.direction = direction;
    state.pendingDirection = direction;
    state.lastStepAt += state.tickMs;
  }

  return state;
}
