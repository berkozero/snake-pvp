import { describe, expect, it } from 'vitest';
import { createRoomForTests } from '../../../../apps/server/src/room';
import { BOARD_HEIGHT, BOARD_WIDTH, COUNTDOWN_MS, MATCH_DURATION_MS, MOVEMENT_MS, TICK_MS } from '../constants';
import {
  SnakeSimulator,
  createSeededRandom,
  createSeededRandomFactory,
  createSimulatorSnapshot,
  createTestState,
} from '../core';
import {
  EnvActionOrder,
  SnakeMlEnvironment,
  createObservationVector,
  getImmediateActionFeatures,
  getLegalActionMask,
  immediateActionFeatureOrder,
  observationVectorLength,
  observationVersion,
} from './index';
import type { EnvAction } from './index';
import type { Direction, PlayerId, RoundState } from '../types';

function setEnvironmentState(env: SnakeMlEnvironment, state: RoundState, seed = 123): void {
  const simulator = new SnakeSimulator({ randomFactory: createSeededRandomFactory(seed) });
  (simulator as unknown as { state: RoundState }).state = state;
  (simulator as unknown as { movementAccumulatorMs: number }).movementAccumulatorMs = 0;
  (env as unknown as { simulator: SnakeSimulator; effectiveSeed: number; decisionSteps: unknown[] }).simulator = simulator;
  (env as unknown as { simulator: SnakeSimulator; effectiveSeed: number; decisionSteps: unknown[] }).effectiveSeed = seed;
  (env as unknown as { simulator: SnakeSimulator; effectiveSeed: number; decisionSteps: unknown[] }).decisionSteps = [];
}

function setRoomState(room: ReturnType<typeof createRoomForTests>, state: RoundState): void {
  room.game = state;
  room.phase =
    state.phase === 'menu' || state.phase === 'paused'
      ? 'waiting'
      : state.phase;
  (room as unknown as { lastSimulationAt: number | null }).lastSimulationAt = state.clockMs;
  (room as unknown as { movementAccumulatorMs: number }).movementAccumulatorMs = 0;
}

function createParityHarness(seed: number) {
  let now = 1_000;
  const room = createRoomForTests({
    now: () => now,
    random: createSeededRandom(seed),
  });

  room.connect('s1');
  room.connect('s2');
  room.handleMessage('s1', JSON.stringify({ v: 1, roomId: 'main', roundId: room.roundId, type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' }));
  room.handleMessage('s2', JSON.stringify({ v: 1, roomId: 'main', roundId: room.roundId, type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' }));
  room.handleMessage('s1', JSON.stringify({ v: 1, roomId: 'main', roundId: room.roundId, type: 'start_match', requestId: 'c' }));

  for (let elapsed = 0; elapsed < COUNTDOWN_MS; elapsed += TICK_MS) {
    now += TICK_MS;
    room.tick();
  }

  let inputSeq = 0;

  return {
    room,
    snapshot() {
      if (!room.game) {
        throw new Error('Expected room game to exist');
      }

      return createSimulatorSnapshot(room.game);
    },
    step(actions: Record<PlayerId, EnvAction>) {
      for (const [playerId, action] of Object.entries(actions) as Array<[PlayerId, EnvAction]>) {
        if (action === 'stay') {
          continue;
        }

        inputSeq += 1;
        const socketId = playerId === 'p1' ? 's1' : 's2';
        room.handleMessage(
          socketId,
          JSON.stringify({
            v: 1,
            roomId: 'main',
            roundId: room.roundId,
            type: 'input_direction',
            direction: action,
            inputSeq,
            clientTime: now,
          }),
        );
      }

      for (let elapsed = 0; elapsed < MOVEMENT_MS; elapsed += TICK_MS) {
        now += TICK_MS;
        room.tick();
      }
    },
    setState(state: RoundState) {
      setRoomState(room, state);
      now = state.clockMs;
    },
  };
}

function extractGameplayFields(snapshot: ReturnType<typeof createSimulatorSnapshot>) {
  return {
    phase: snapshot.phase,
    countdownMs: snapshot.countdownMs,
    remainingMs: snapshot.remainingMs,
    food: snapshot.food,
    winner: snapshot.winner,
    players: {
      p1: {
        alive: snapshot.players.p1.alive,
        direction: snapshot.players.p1.direction,
        pendingDirection: snapshot.players.p1.pendingDirection,
        segments: snapshot.players.p1.segments,
        head: snapshot.players.p1.head,
        score: snapshot.players.p1.score,
        respawnRemainingMs: snapshot.players.p1.respawnRemainingMs,
        respawnPreview: snapshot.players.p1.respawnPreview,
      },
      p2: {
        alive: snapshot.players.p2.alive,
        direction: snapshot.players.p2.direction,
        pendingDirection: snapshot.players.p2.pendingDirection,
        segments: snapshot.players.p2.segments,
        head: snapshot.players.p2.head,
        score: snapshot.players.p2.score,
        respawnRemainingMs: snapshot.players.p2.respawnRemainingMs,
        respawnPreview: snapshot.players.p2.respawnPreview,
      },
    },
  };
}

function expectGameplayParity(env: SnakeMlEnvironment, room: ReturnType<typeof createParityHarness>) {
  expect(extractGameplayFields(env.captureReplayArtifact().finalSnapshot)).toEqual(extractGameplayFields(room.snapshot()));
}

describe('SnakeMlEnvironment', () => {
  it('reset returns the first decision-ready playing state before any movement', () => {
    const env = new SnakeMlEnvironment({ testMode: true });
    const result = env.reset();
    const snapshot = env.captureReplayArtifact().finalSnapshot;

    expect(result.done).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.observationVersion).toBe(2);
    expect(snapshot.phase).toBe('playing');
    expect(snapshot.clockMs).toBe(COUNTDOWN_MS);
    expect(snapshot.countdownMs).toBe(0);
    expect(snapshot.players.p1.head).toEqual({ x: 8, y: Math.floor(BOARD_HEIGHT / 2) });
    expect(snapshot.players.p2.head).toEqual({ x: BOARD_WIDTH - 9, y: Math.floor(BOARD_HEIGHT / 2) });
  });

  it('step advances exactly one decision interval', () => {
    const env = new SnakeMlEnvironment({ testMode: true });
    env.reset(7);

    const result = env.step({ p1: 'stay', p2: 'stay' });
    const snapshot = env.captureReplayArtifact().finalSnapshot;

    expect(result.done).toBe(false);
    expect(snapshot.clockMs).toBe(COUNTDOWN_MS + MOVEMENT_MS);
    expect(snapshot.players.p1.head).toEqual({ x: 9, y: Math.floor(BOARD_HEIGHT / 2) });
    expect(snapshot.players.p2.head).toEqual({ x: BOARD_WIDTH - 10, y: Math.floor(BOARD_HEIGHT / 2) });
  });

  it('treats stay as submit-no-new-input rather than stop-moving', () => {
    const env = new SnakeMlEnvironment({ testMode: true });
    env.reset(7);

    env.step({ p1: 'up', p2: 'stay' });
    const afterTurn = env.captureReplayArtifact().finalSnapshot;
    const afterStay = env.step({ p1: 'stay', p2: 'stay' });
    const snapshot = env.captureReplayArtifact().finalSnapshot;

    expect(afterTurn.players.p1.direction).toBe('up');
    expect(snapshot.players.p1.direction).toBe('up');
    expect(snapshot.players.p1.head).toEqual({ x: 8, y: Math.floor(BOARD_HEIGHT / 2) - 2 });
    expect(afterStay.done).toBe(false);
  });

  it('produces deterministic episodes for the same seed and action sequence', () => {
    const actions: Array<Record<PlayerId, EnvAction>> = [
      { p1: 'up', p2: 'stay' },
      { p1: 'left', p2: 'down' },
      { p1: 'stay', p2: 'right' },
      { p1: 'down', p2: 'stay' },
    ];

    const run = () => {
      const env = new SnakeMlEnvironment();
      const resets = env.reset(42);
      const steps = actions.map((action) => env.step(action));
      return {
        resets,
        steps,
        replay: env.captureReplayArtifact(),
        p1Observation: env.getObservation('p1'),
        p2Mask: env.getActionMask('p2'),
      };
    };

    expect(run()).toEqual(run());
  });

  it('can produce different food trajectories for different seeds', () => {
    const first = new SnakeMlEnvironment();
    const second = new SnakeMlEnvironment();

    first.reset(1);
    second.reset(2);

    expect(first.captureReplayArtifact().finalSnapshot.food).not.toEqual(second.captureReplayArtifact().finalSnapshot.food);
  });

  it('encodes observation v2 with a fixed feature order and perspective swap', () => {
    const snapshot = createSimulatorSnapshot(
      createTestState({
        phase: 'playing',
        countdownMs: 0,
        clockMs: COUNTDOWN_MS,
        remainingMs: 1_234,
        food: { x: 8, y: 2 },
        players: {
          p1: {
            score: 2,
            direction: 'up',
            pendingDirection: 'left',
            segments: [{ x: 5, y: 6 }, { x: 5, y: 7 }, { x: 5, y: 8 }, { x: 5, y: 9 }],
          },
          p2: {
            score: 1,
            direction: 'down',
            pendingDirection: 'right',
            segments: [{ x: 20, y: 15 }, { x: 20, y: 14 }, { x: 20, y: 13 }],
          },
        },
      }),
    );

    expect(observationVersion).toBe(2);
    expect(observationVectorLength).toBe(44);
    expect(immediateActionFeatureOrder).toEqual([
      'legal',
      'wouldHitWall',
      'wouldHitSelf',
      'wouldHitEnemyBody',
      'wouldLoseHeadOn',
    ]);
    expect(createObservationVector(snapshot, 'p1')).toEqual([
      5, 6, 0, 2, 4, 2, 1, 0, 20, 15, 1, 3, 3, 1, 1, 0, 3, -4, 1234,
      1, 0, 0, 0, 0,
      0, 0, 1, 0, 0,
      1, 0, 0, 0, 0,
      1, 0, 0, 0, 0,
      1, 0, 0, 0, 0,
    ]);
    expect(createObservationVector(snapshot, 'p2')).toEqual([
      20, 15, 1, 3, 3, 1, 1, 0, 5, 6, 0, 2, 4, 2, 1, 0, -12, -13, 1234,
      0, 0, 1, 0, 0,
      1, 0, 0, 0, 0,
      1, 0, 0, 0, 0,
      1, 0, 0, 0, 0,
      1, 0, 0, 0, 0,
    ]);
    expect(createObservationVector(snapshot, 'p1')).toHaveLength(observationVectorLength);
  });

  it('reports immediate per-action features with stable ordering', () => {
    const snapshot = createSimulatorSnapshot(
      createTestState({
        phase: 'playing',
        countdownMs: 0,
        players: {
          p1: {
            direction: 'up',
            pendingDirection: 'up',
            segments: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }],
          },
          p2: {
            direction: 'left',
            pendingDirection: 'left',
            segments: [{ x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }, { x: 5, y: 0 }],
          },
        },
      }),
    );

    expect(getImmediateActionFeatures(snapshot, 'p1')).toEqual([
      { action: 'up', legal: true, wouldHitWall: true, wouldHitSelf: false, wouldHitEnemyBody: false, wouldLoseHeadOn: false },
      { action: 'down', legal: false, wouldHitWall: false, wouldHitSelf: true, wouldHitEnemyBody: false, wouldLoseHeadOn: false },
      { action: 'left', legal: true, wouldHitWall: true, wouldHitSelf: false, wouldHitEnemyBody: false, wouldLoseHeadOn: false },
      { action: 'right', legal: true, wouldHitWall: false, wouldHitSelf: false, wouldHitEnemyBody: false, wouldLoseHeadOn: true },
      { action: 'stay', legal: true, wouldHitWall: true, wouldHitSelf: false, wouldHitEnemyBody: false, wouldLoseHeadOn: false },
    ]);
  });

  it('returns action masks in EnvActionOrder and only applies rule legality', () => {
    const snapshot = createSimulatorSnapshot(
      createTestState({
        phase: 'playing',
        countdownMs: 0,
        players: {
          p1: {
            direction: 'right',
            pendingDirection: 'up',
            segments: [{ x: BOARD_WIDTH - 1, y: 2 }, { x: BOARD_WIDTH - 2, y: 2 }, { x: BOARD_WIDTH - 3, y: 2 }, { x: BOARD_WIDTH - 4, y: 2 }],
          },
        },
      }),
    );

    expect(EnvActionOrder).toEqual(['up', 'down', 'left', 'right', 'stay']);
    expect(getLegalActionMask(snapshot, 'p1')).toEqual([true, true, false, true, true]);
  });

  it('returns food rewards when a player grows', () => {
    const env = new SnakeMlEnvironment({ testMode: true });
    setEnvironmentState(
      env,
      createTestState(
        {
          phase: 'playing',
          countdownMs: 0,
          clockMs: COUNTDOWN_MS,
          remainingMs: MATCH_DURATION_MS,
          food: { x: 6, y: 5 },
          players: {
            p1: {
              direction: 'right',
              pendingDirection: 'right',
              segments: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }],
            },
          },
        },
        { random: createSeededRandomFactory(99)() },
      ),
    );

    const result = env.step({ p1: 'stay', p2: 'stay' });

    expect(result.info.rewardBreakdown.p1.food_gained).toBe(0.1);
    expect(result.rewards.p1).toBe(0.1);
    expect(env.captureReplayArtifact().finalSnapshot.players.p1.length).toBe(5);
  });

  it('returns a death penalty on collision without tactical masking', () => {
    const env = new SnakeMlEnvironment({ testMode: true });
    setEnvironmentState(
      env,
      createTestState({
        phase: 'playing',
        countdownMs: 0,
        clockMs: COUNTDOWN_MS,
        remainingMs: MATCH_DURATION_MS,
        players: {
          p1: {
            direction: 'left',
            pendingDirection: 'left',
            segments: [{ x: 0, y: 10 }, { x: 1, y: 10 }, { x: 2, y: 10 }, { x: 3, y: 10 }],
          },
        },
      }),
    );

    const result = env.step({ p1: 'stay', p2: 'stay' });

    expect(result.done).toBe(false);
    expect(result.info.rewardBreakdown.p1.death).toBe(-0.2);
    expect(result.rewards.p1).toBe(-0.2);
    expect(env.captureReplayArtifact().finalSnapshot.players.p1.alive).toBe(false);
  });

  it('returns terminal rewards for both players and never truncates on normal timeout', () => {
    const env = new SnakeMlEnvironment({ testMode: true });
    setEnvironmentState(
      env,
      createTestState({
        phase: 'playing',
        countdownMs: 0,
        clockMs: COUNTDOWN_MS,
        remainingMs: MOVEMENT_MS,
        players: {
          p1: {
            score: 3,
          },
          p2: {
            score: 1,
          },
        },
      }),
    );

    const result = env.step({ p1: 'stay', p2: 'stay' });

    expect(result.done).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.rewards).toEqual({ p1: 1, p2: -1 });
    expect(result.info.rewardBreakdown.p1.win).toBe(1);
    expect(result.info.rewardBreakdown.p2.loss).toBe(-1);
  });

  it('throws on malformed actions instead of silently degrading input', () => {
    const env = new SnakeMlEnvironment({ testMode: true });
    env.reset(5);

    expect(() => env.step({ p1: 'stay' } as never)).toThrow(/actions/i);
    expect(() => env.step({ p1: 'stay', p2: 'noop' } as never)).toThrow(/actions\.p1 and actions\.p2/i);
  });

  it('throws if step is called after the episode is terminal', () => {
    const env = new SnakeMlEnvironment({ testMode: true });
    setEnvironmentState(
      env,
      createTestState({
        phase: 'playing',
        countdownMs: 0,
        clockMs: COUNTDOWN_MS,
        remainingMs: MOVEMENT_MS,
        players: {
          p1: { score: 2 },
          p2: { score: 1 },
        },
      }),
    );

    const terminal = env.step({ p1: 'stay', p2: 'stay' });
    expect(terminal.done).toBe(true);
    expect(() => env.step({ p1: 'stay', p2: 'stay' })).toThrow(/terminal state/i);
    expect(env.captureReplayArtifact().decisionSteps).toHaveLength(1);
  });

  it('stays aligned with MainRoom tick semantics across a long seeded scripted match', () => {
    const seed = 42;
    const env = new SnakeMlEnvironment();
    const room = createParityHarness(seed);
    const actions: Array<Record<PlayerId, EnvAction>> = Array.from({ length: 40 }, (_, index) => ({
      p1: EnvActionOrder[index % EnvActionOrder.length],
      p2: EnvActionOrder[(index * 2) % EnvActionOrder.length],
    }));

    env.reset(seed);
    expectGameplayParity(env, room);

    for (const action of actions) {
      env.step(action);
      room.step(action);
      expectGameplayParity(env, room);
    }
  });

  it('matches MainRoom respawn semantics on a forced respawn step', () => {
    const env = new SnakeMlEnvironment({ testMode: true });
    const room = createParityHarness(77);
    const sharedState = createTestState({
      phase: 'playing',
      countdownMs: 0,
      clockMs: COUNTDOWN_MS,
      remainingMs: MATCH_DURATION_MS,
      players: {
        p1: {
          alive: false,
          segments: [],
          respawnAt: COUNTDOWN_MS + 50,
          respawnPreview: { head: { x: 10, y: 10 }, direction: 'right' },
        },
        p2: {
          direction: 'left',
          pendingDirection: 'left',
          segments: [{ x: 25, y: 10 }, { x: 26, y: 10 }, { x: 27, y: 10 }, { x: 28, y: 10 }],
        },
      },
    });

    setEnvironmentState(env, sharedState, 77);
    room.setState(sharedState);

    env.step({ p1: 'stay', p2: 'stay' });
    room.step({ p1: 'stay', p2: 'stay' });

    expectGameplayParity(env, room);
  });

  it('matches MainRoom timeout finish semantics on the terminal transition', () => {
    const env = new SnakeMlEnvironment({ testMode: true });
    const room = createParityHarness(88);
    const sharedState = createTestState({
      phase: 'playing',
      countdownMs: 0,
      clockMs: COUNTDOWN_MS,
      remainingMs: MOVEMENT_MS,
      players: {
        p1: { score: 4 },
        p2: { score: 1 },
      },
    });

    setEnvironmentState(env, sharedState, 88);
    room.setState(sharedState);

    const result = env.step({ p1: 'stay', p2: 'stay' });
    room.step({ p1: 'stay', p2: 'stay' });

    expect(result.done).toBe(true);
    expect(result.truncated).toBe(false);
    expectGameplayParity(env, room);
  });

  it('captures replay artifacts that reproduce the final simulator state', () => {
    const env = new SnakeMlEnvironment();
    env.reset(42);
    env.step({ p1: 'up', p2: 'stay' });
    env.step({ p1: 'left', p2: 'down' });
    env.step({ p1: 'stay', p2: 'stay' });

    const artifact = env.captureReplayArtifact();
    const replay = artifact.replayScript;
    const replayer = new SnakeSimulator({ randomFactory: createSeededRandomFactory(replay.seed) });
    replayer.startCountdown();
    const final = runReplayToEnd(replayer, replay.actions, replay.endAtMs);

    expect(final).toEqual(artifact.finalSnapshot);
  });
});

function runReplayToEnd(simulator: SnakeSimulator, actions: Array<{ atMs: number; playerId: PlayerId; direction: Direction }>, endAtMs: number) {
  let actionIndex = 0;

  while (simulator.getState().clockMs < endAtMs && simulator.getState().phase !== 'finished') {
    const targetTime = Math.min(simulator.getState().clockMs + TICK_MS, endAtMs);
    while (actionIndex < actions.length && actions[actionIndex].atMs <= targetTime) {
      const action = actions[actionIndex];
      if (action.atMs > simulator.getState().clockMs) {
        simulator.advanceElapsed(action.atMs - simulator.getState().clockMs);
      }
      simulator.submitAction(action.playerId, action.direction);
      actionIndex += 1;
    }

    if (simulator.getState().clockMs < targetTime) {
      simulator.advanceElapsed(targetTime - simulator.getState().clockMs);
    }
  }

  return simulator.snapshot();
}
