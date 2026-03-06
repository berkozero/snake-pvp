import { describe, expect, it } from 'vitest';
import { MATCH_DURATION_MS, RESPAWN_DELAY_MS } from './constants';
import { createDeterministicRandom, createTestState, queueDirection, tick } from './engine';
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

    const respawnedState = tick(deadState, state.tickMs, 1000 + RESPAWN_DELAY_MS, { random: createDeterministicRandom([0]) }).state;
    expect(respawnedState.players.p1.alive).toBe(true);
    expect(respawnedState.players.p1.score).toBe(4);
    expect(respawnedState.players.p1.segments.length).toBeGreaterThan(0);
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
      remainingMs: 125,
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
