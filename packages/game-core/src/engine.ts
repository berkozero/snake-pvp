import type { RoundState } from './types';
import { applyDirection, createSimulatorSnapshot } from './core';

export {
  SnakeSimulator,
  canUseDirection,
  createDeterministicRandom,
  createGameState,
  createTestState,
  getRespawnCountdown,
  getRespawnRemainingMs,
  pickFoodCell,
  restartGame,
  runReplay,
  runReplayFrames,
  startCountdown,
  tick,
  togglePause,
} from './core';

export function queueDirection(state: RoundState, key: string): RoundState {
  const normalized = key.toLowerCase();

  let nextState = state;
  for (const playerId of ['p1', 'p2'] as const) {
    const direction = state.players[playerId].keyMap[normalized];
    if (direction) {
      nextState = applyDirection(nextState, playerId, direction);
    }
  }

  return nextState;
}

export function serializeState(state: RoundState) {
  return createSimulatorSnapshot(state);
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
