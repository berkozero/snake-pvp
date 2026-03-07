import { describe, expect, it } from 'vitest';
import { MATCH_DURATION_MS } from '../constants';
import type { Direction } from '../types';
import {
  SnakeSimulator,
  applyDirection,
  chooseHeuristicDirection,
  createDeterministicRandom,
  createDeterministicRandomFactory,
  createTestState,
  runReplay,
  runReplayFrames,
  startCountdown,
  tick,
} from './index';

function makePlayingState(overrides: Parameters<typeof createTestState>[0] = {}) {
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

describe('game core simulator', () => {
  it('keeps only the latest legal pending direction before movement', () => {
    const state = makePlayingState({
      players: {
        p1: {
          direction: 'right',
          pendingDirection: 'right',
        },
      },
    });

    const afterUp = applyDirection(state, 'p1', 'up');
    const afterIllegalReverse = applyDirection(afterUp, 'p1', 'left');
    const afterDown = applyDirection(afterIllegalReverse, 'p1', 'down');

    expect(afterDown.players.p1.pendingDirection).toBe('down');
  });

  it('produces identical trajectories for the same seed and action sequence', () => {
    const actions: Array<{ playerId: 'p1' | 'p2'; direction: Direction }> = [
      { playerId: 'p1', direction: 'up' },
      { playerId: 'p2', direction: 'down' },
      { playerId: 'p1', direction: 'left' },
    ];

    const runMatch = () => {
      const simulator = new SnakeSimulator({ random: createDeterministicRandom([0.1, 0.7, 0.3, 0.9]) });
      simulator.startCountdown();
      simulator.advanceTime(2_400);
      for (const action of actions) {
        simulator.submitAction(action.playerId, action.direction);
        simulator.stepMovement();
      }
      return simulator.snapshot();
    };

    expect(runMatch()).toEqual(runMatch());
  });

  it('reset restarts a deterministic simulator from the same random source', () => {
    const simulator = new SnakeSimulator({
      randomFactory: createDeterministicRandomFactory([0.1, 0.7, 0.3, 0.9]),
    });

    const initial = simulator.snapshot();
    simulator.startCountdown();
    simulator.advanceTime(2_400);
    simulator.stepMovement();

    simulator.reset();

    expect(simulator.snapshot()).toEqual(initial);
  });

  it('replays the same match from seed and ordered actions alone', () => {
    const replay = {
      seed: 42,
      actions: [
        { atMs: 2_450, playerId: 'p1' as const, direction: 'up' as const },
        { atMs: 2_500, playerId: 'p2' as const, direction: 'down' as const },
        { atMs: 2_600, playerId: 'p1' as const, direction: 'left' as const },
      ],
      endAtMs: 2_800,
    };

    const first = runReplay(replay);
    const second = runReplay(replay);

    expect(first).toEqual(second);
    expect(first.at(-1)?.clockMs).toBe(2_800);
  });

  it('records post-action replay frames so pending direction changes are visible before movement', () => {
    const frames = runReplayFrames({
      seed: 42,
      actions: [{ atMs: 2_450, playerId: 'p1', direction: 'up' }],
      endAtMs: 2_500,
    });

    const actionFrame = frames.find((frame) => frame.reason === 'action_applied');
    expect(actionFrame?.snapshot.players.p1.pendingDirection).toBe('up');
    expect(actionFrame?.snapshot.players.p1.direction).toBe('right');
  });

  it('preserves countdown remainder before the first replayed movement step', () => {
    const replay = {
      seed: 7,
      actions: [],
      endAtMs: 2_525,
    };

    const snapshots = runReplay(replay);
    const final = snapshots.at(-1);

    expect(final?.phase).toBe('playing');
    expect(final?.remainingMs).toBe(MATCH_DURATION_MS - 125);
    expect(final?.players.p1.head).toEqual({ x: 9, y: 12 });
    expect(final?.players.p2.head).toEqual({ x: 26, y: 12 });
  });

  it('exposes a stable bot-readable snapshot contract', () => {
    const simulator = new SnakeSimulator({ random: createDeterministicRandom([0.25]) });
    const snapshot = simulator.snapshot();

    expect(snapshot).toEqual({
      phase: 'menu',
      board: { width: 36, height: 24 },
      clockMs: 0,
      countdownMs: 2400,
      remainingMs: 90000,
      winner: null,
      food: snapshot.food,
      players: {
        p1: {
          alive: true,
          score: 0,
          direction: 'right',
          pendingDirection: 'right',
          length: 4,
          segments: snapshot.players.p1.segments,
          head: snapshot.players.p1.head,
          respawnRemainingMs: 0,
          respawnCountdown: null,
          respawnPreview: null,
        },
        p2: {
          alive: true,
          score: 0,
          direction: 'left',
          pendingDirection: 'left',
          length: 4,
          segments: snapshot.players.p2.segments,
          head: snapshot.players.p2.head,
          respawnRemainingMs: 0,
          respawnCountdown: null,
          respawnPreview: null,
        },
      },
    });
  });

  it('chooses a safe food-seeking move when one exists', () => {
    const snapshot = {
      ...new SnakeSimulator({ random: createDeterministicRandom([0]) }).snapshot(),
      phase: 'playing' as const,
      food: { x: 9, y: 10 },
      players: {
        p1: {
          alive: true,
          score: 0,
          direction: 'right' as const,
          pendingDirection: 'right' as const,
          length: 4,
          segments: [{ x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }, { x: 5, y: 10 }],
          head: { x: 8, y: 10 },
          respawnRemainingMs: 0,
          respawnCountdown: null,
          respawnPreview: null,
        },
        p2: {
          alive: true,
          score: 0,
          direction: 'left' as const,
          pendingDirection: 'left' as const,
          length: 5,
          segments: [{ x: 11, y: 10 }, { x: 12, y: 10 }, { x: 13, y: 10 }, { x: 14, y: 10 }, { x: 15, y: 10 }],
          head: { x: 11, y: 10 },
          respawnRemainingMs: 0,
          respawnCountdown: null,
          respawnPreview: null,
        },
      },
    };

    expect(chooseHeuristicDirection(snapshot, 'p1')).toBe('right');
  });

  it('does not treat the tail as vacating on a food-growth move', () => {
    const snapshot = {
      ...new SnakeSimulator({ random: createDeterministicRandom([0]) }).snapshot(),
      phase: 'playing' as const,
      food: { x: 5, y: 6 },
      players: {
        p1: {
          alive: true,
          score: 0,
          direction: 'up' as const,
          pendingDirection: 'up' as const,
          length: 4,
          segments: [{ x: 5, y: 7 }, { x: 6, y: 7 }, { x: 6, y: 6 }, { x: 5, y: 6 }],
          head: { x: 5, y: 7 },
          respawnRemainingMs: 0,
          respawnCountdown: null,
          respawnPreview: null,
        },
        p2: {
          alive: true,
          score: 0,
          direction: 'left' as const,
          pendingDirection: 'left' as const,
          length: 4,
          segments: [{ x: 20, y: 20 }, { x: 21, y: 20 }, { x: 22, y: 20 }, { x: 23, y: 20 }],
          head: { x: 20, y: 20 },
          respawnRemainingMs: 0,
          respawnCountdown: null,
          respawnPreview: null,
        },
      },
    };

    expect(chooseHeuristicDirection(snapshot, 'p1')).toBe('left');
  });

  it('lets the heuristic bot complete simulated turns without dying immediately', () => {
    const simulator = new SnakeSimulator({ random: createDeterministicRandom([0.1, 0.4, 0.6, 0.8, 0.2]) });
    simulator.startCountdown();
    simulator.advanceElapsed(2_400);

    for (let index = 0; index < 12; index += 1) {
      const move = chooseHeuristicDirection(simulator.snapshot(), 'p1');
      simulator.submitAction('p1', move);
      simulator.advanceElapsed(simulator.getState().movementMs);
      const snapshot = simulator.snapshot();
      expect(snapshot.players.p1.alive).toBe(true);
      expect(snapshot.clockMs).toBe(2_400 + (index + 1) * simulator.getState().movementMs);
    }
  });

  it('advanceElapsed applies timer and movement semantics together', () => {
    const simulator = new SnakeSimulator({ random: createDeterministicRandom([0.2, 0.4, 0.6]) });
    simulator.startCountdown();

    const result = simulator.advanceElapsed(2_525);
    const snapshot = simulator.snapshot();

    expect(result.movementSteps).toBe(1);
    expect(snapshot.phase).toBe('playing');
    expect(snapshot.remainingMs).toBe(MATCH_DURATION_MS - 125);
    expect(snapshot.clockMs).toBe(2_525);
    expect(snapshot.players.p1.head).toEqual({ x: 9, y: 12 });
  });

  it('keeps different seeds rule-compatible while changing random events', () => {
    const state = startCountdown(createTestState({}, { random: createDeterministicRandom([0.1]) }));
    const first = tick(state, 2_400, 2_400, { random: createDeterministicRandom([0.2, 0.4]), shouldMove: false }).state;
    const second = tick(state, 2_400, 2_400, { random: createDeterministicRandom([0.8, 0.6]), shouldMove: false }).state;

    expect(first.phase).toBe('playing');
    expect(second.phase).toBe('playing');
    expect(first.players.p1.direction).toBe(second.players.p1.direction);
  });
});
