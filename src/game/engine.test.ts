import { describe, expect, it } from 'vitest';
import { BOARD_HEIGHT, BOARD_WIDTH, MATCH_DURATION_MS, RESPAWN_DELAY_MS } from './constants';
import { createDeterministicRandom, createTestState, getRespawnCountdown, pickFoodCell, queueDirection, tick } from './engine';
import type { RoundState } from './types';

function makePlayingState(overrides: Parameters<typeof createTestState>[0] = {}): RoundState {
  return createTestState(
    {
      phase: 'playing',
      countdownMs: 0,
      remainingMs: MATCH_DURATION_MS,
      ...overrides,
    },
    { random: createDeterministicRandom([0]) },
  );
}

describe('engine', () => {
  it('awards both players when they reach food on the same tick', () => {
    const state = makePlayingState({
      players: {
        p1: { segments: [{ x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }, { x: 1, y: 5 }], direction: 'right', pendingDirection: 'right' },
        p2: { segments: [{ x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }], direction: 'left', pendingDirection: 'left' },
      },
      food: { x: 5, y: 5 },
    });

    const result = tick(state, state.tickMs, 1000, { random: createDeterministicRandom([0.3]) }).state;

    expect(result.players.p1.score).toBe(1);
    expect(result.players.p2.score).toBe(1);
    expect(result.players.p1.segments).toHaveLength(5);
    expect(result.players.p2.segments).toHaveLength(5);
  });

  it('advances timers on heartbeat ticks without moving snakes', () => {
    const state = makePlayingState({
      remainingMs: 500,
      players: {
        p1: {
          segments: [{ x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }, { x: 1, y: 5 }],
          direction: 'right',
          pendingDirection: 'right',
        },
      },
    });

    const result = tick(state, 50, 1_050, { shouldMove: false });

    expect(result.state.remainingMs).toBe(450);
    expect(result.state.clockMs).toBe(50);
    expect(result.state.players.p1.segments[0]).toEqual({ x: 4, y: 5 });
    expect(result.didAdvanceBoard).toBe(false);
  });

  it('moves only on the configured movement step after heartbeat ticks advance timers', () => {
    const state = makePlayingState({
      remainingMs: 500,
      players: {
        p1: {
          segments: [{ x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }, { x: 1, y: 5 }],
          direction: 'right',
          pendingDirection: 'down',
        },
      },
    });

    const heartbeat = tick(state, 50, 1_050, { shouldMove: false }).state;
    const moved = tick(heartbeat, 0, 1_100, { shouldMove: true }).state;

    expect(heartbeat.players.p1.segments[0]).toEqual({ x: 4, y: 5 });
    expect(moved.players.p1.segments[0]).toEqual({ x: 4, y: 6 });
    expect(moved.remainingMs).toBe(450);
  });

  it('ignores instant reverse inputs', () => {
    const state = makePlayingState({
      players: {
        p1: { direction: 'right', pendingDirection: 'right' },
      },
    });

    const queued = queueDirection(state, 'a');

    expect(queued.players.p1.pendingDirection).toBe('right');
  });

  it('kills a snake that hits the wall and respawns later without losing score', () => {
    const state = makePlayingState({
      players: {
        p1: {
          score: 4,
          segments: [{ x: 35, y: 5 }, { x: 34, y: 5 }, { x: 33, y: 5 }, { x: 32, y: 5 }],
          direction: 'right',
          pendingDirection: 'right',
        },
      },
    });

    const deadState = tick(state, state.tickMs, 1000, { random: createDeterministicRandom([0]) }).state;
    expect(deadState.players.p1.alive).toBe(false);
    expect(deadState.players.p1.score).toBe(4);
    expect(deadState.players.p1.respawnPreview).not.toBeNull();
    expect(getRespawnCountdown(deadState.players.p1, deadState.clockMs)).toBe(3);
    expect(getRespawnCountdown(deadState.players.p1, deadState.clockMs + 1001)).toBe(2);
    expect(getRespawnCountdown(deadState.players.p1, deadState.clockMs + 2001)).toBe(1);

    const respawnedState = tick(deadState, RESPAWN_DELAY_MS, 1000 + RESPAWN_DELAY_MS, { random: createDeterministicRandom([0]) }).state;
    expect(respawnedState.players.p1.alive).toBe(true);
    expect(respawnedState.players.p1.score).toBe(4);
    expect(respawnedState.players.p1.segments.length).toBeGreaterThan(0);
    expect(respawnedState.players.p1.respawnPreview).toBeNull();
  });

  it('locks the respawn preview across intermediate ticks and respawns at the previewed location and direction', () => {
    const state = makePlayingState({
      players: {
        p1: {
          segments: [{ x: 35, y: 5 }, { x: 34, y: 5 }, { x: 33, y: 5 }, { x: 32, y: 5 }],
          direction: 'right',
          pendingDirection: 'right',
        },
      },
    });

    const deadState = tick(state, state.tickMs, 1000, { random: createDeterministicRandom([0.21]) }).state;
    const preview = deadState.players.p1.respawnPreview;
    expect(preview).not.toBeNull();

    const duringDelay = tick(deadState, 1_500, 2_500, { random: createDeterministicRandom([0.93]) }).state;
    expect(duringDelay.players.p1.alive).toBe(false);
    expect(duringDelay.players.p1.respawnPreview).toEqual(preview);

    const respawnedState = tick(duringDelay, 1_500, 4_000, { random: createDeterministicRandom([0.04]) }).state;
    expect(respawnedState.players.p1.alive).toBe(true);
    expect(respawnedState.players.p1.direction).toBe(preview?.direction);
    expect(respawnedState.players.p1.segments[0]).toEqual(preview?.head);
    expect(respawnedState.players.p1.respawnPreview).toBeNull();
  });

  it('respawns on a heartbeat tick as soon as the respawn timer expires', () => {
    const state = makePlayingState({
      players: {
        p1: {
          segments: [{ x: 35, y: 5 }, { x: 34, y: 5 }, { x: 33, y: 5 }, { x: 32, y: 5 }],
          direction: 'right',
          pendingDirection: 'right',
        },
      },
    });

    const deadState = tick(state, state.tickMs, 1_000, { random: createDeterministicRandom([0]) }).state;
    const respawned = tick(deadState, RESPAWN_DELAY_MS, 4_000, {
      random: createDeterministicRandom([0]),
      shouldMove: false,
    }).state;

    expect(respawned.players.p1.alive).toBe(true);
    expect(respawned.players.p1.respawnPreview).toBeNull();
  });

  it('respawns food only on free cells, even when only one cell is open', () => {
    const occupiedCells = [];
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      for (let x = 0; x < BOARD_WIDTH; x += 1) {
        if (!(x === 10 && y === 10)) {
          occupiedCells.push({ x, y });
        }
      }
    }

    const state = makePlayingState({
      players: {
        p1: {
          segments: occupiedCells.slice(0, Math.floor(occupiedCells.length / 2)),
        },
        p2: {
          segments: occupiedCells.slice(Math.floor(occupiedCells.length / 2)),
        },
      },
    });

    const food = pickFoodCell(state.players, createDeterministicRandom([0.99]));

    expect(food).toEqual({ x: 10, y: 10 });
  });

  it('makes food slightly less likely to respawn in the outer three-cell border band', () => {
    const occupiedCells = [];
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      for (let x = 0; x < BOARD_WIDTH; x += 1) {
        const isInteriorCell = x === 3 && y === 3;
        const isEdgeBandCell = x === 0 && y === 0;
        if (!isInteriorCell && !isEdgeBandCell) {
          occupiedCells.push({ x, y });
        }
      }
    }

    const state = makePlayingState({
      players: {
        p1: { segments: occupiedCells.slice(0, Math.floor(occupiedCells.length / 2)) },
        p2: { segments: occupiedCells.slice(Math.floor(occupiedCells.length / 2)) },
      },
    });

    const food = pickFoodCell(state.players, createDeterministicRandom([0.4]));

    expect(food).toEqual({ x: 3, y: 3 });
  });

  it('cuts the victim from the bitten segment through the tail', () => {
    const state = makePlayingState({
      players: {
        p1: { segments: [{ x: 7, y: 9 }, { x: 7, y: 10 }, { x: 6, y: 10 }, { x: 5, y: 10 }], direction: 'up', pendingDirection: 'up' },
        p2: {
          segments: [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }, { x: 6, y: 9 }, { x: 5, y: 9 }],
          direction: 'right',
          pendingDirection: 'right',
        },
      },
      food: { x: 20, y: 20 },
    });

    const result = tick(state, state.tickMs, 1000).state;

    expect(result.players.p1.alive).toBe(true);
    expect(result.players.p2.segments).toEqual([
      { x: 9, y: 8 },
      { x: 8, y: 8 },
      { x: 7, y: 8 },
    ]);
  });

  it('applies simultaneous cuts for both snakes on the same tick', () => {
    const state = makePlayingState({
      players: {
        p1: {
          segments: [{ x: 4, y: 4 }, { x: 4, y: 5 }, { x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 4 }],
          direction: 'right',
          pendingDirection: 'right',
        },
        p2: {
          segments: [{ x: 6, y: 5 }, { x: 6, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 5 }],
          direction: 'left',
          pendingDirection: 'left',
        },
      },
      food: { x: 20, y: 20 },
    });

    const result = tick(state, state.tickMs, 1000).state;

    expect(result.players.p1.alive).toBe(true);
    expect(result.players.p2.alive).toBe(true);
    expect(result.players.p1.segments.length).toBe(4);
    expect(result.players.p2.segments.length).toBe(4);
  });

  it('kills the shorter snake in a head-on collision', () => {
    const state = makePlayingState({
      players: {
        p1: {
          segments: [{ x: 4, y: 4 }, { x: 3, y: 4 }, { x: 2, y: 4 }, { x: 1, y: 4 }, { x: 0, y: 4 }],
          direction: 'right',
          pendingDirection: 'right',
        },
        p2: {
          segments: [{ x: 6, y: 4 }, { x: 7, y: 4 }, { x: 8, y: 4 }, { x: 9, y: 4 }],
          direction: 'left',
          pendingDirection: 'left',
        },
      },
      food: { x: 20, y: 20 },
    });

    const result = tick(state, state.tickMs, 1000).state;

    expect(result.players.p1.alive).toBe(true);
    expect(result.players.p2.alive).toBe(false);
  });

  it('allows moving into a tail cell vacated on the same tick', () => {
    const state = makePlayingState({
      players: {
        p1: { segments: [{ x: 4, y: 5 }, { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 5, y: 5 }], direction: 'right', pendingDirection: 'right' },
        p2: {
          segments: [{ x: 6, y: 5 }, { x: 7, y: 5 }, { x: 7, y: 6 }, { x: 6, y: 6 }, { x: 5, y: 6 }],
          direction: 'up',
          pendingDirection: 'up',
        },
      },
      food: { x: 20, y: 20 },
    });

    const result = tick(state, state.tickMs, 1000).state;

    expect(result.players.p1.alive).toBe(true);
  });

  it('declares a draw when score and length are tied at timeout', () => {
    const state = makePlayingState({
      remainingMs: 50,
      players: {
        p1: { score: 3, segments: [{ x: 4, y: 4 }, { x: 3, y: 4 }, { x: 2, y: 4 }, { x: 1, y: 4 }] },
        p2: { score: 3, segments: [{ x: 10, y: 4 }, { x: 11, y: 4 }, { x: 12, y: 4 }, { x: 13, y: 4 }] },
      },
      food: { x: 20, y: 20 },
    });

    const result = tick(state, state.tickMs, 1000).state;

    expect(result.phase).toBe('finished');
    expect(result.winner).toBe('draw');
  });
});
