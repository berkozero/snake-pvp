import { COUNTDOWN_MS, directionVectors, oppositeDirection } from '../constants';
import {
  SnakeSimulator,
  canUseDirection,
  createSeededRandomFactory,
  runReplay,
} from '../core';
import type { ReplayScript, SimulatorSnapshot } from '../core';
import type { Direction, PlayerId } from '../types';

const PLAYER_IDS: PlayerId[] = ['p1', 'p2'];
const DEFAULT_TEST_SEED = 1_337;
const NULL_COORDINATE = -1;

export const EnvActionOrder = ['up', 'down', 'left', 'right', 'stay'] as const;
export type EnvAction = (typeof EnvActionOrder)[number];
export const observationVersion = 2;
export const immediateActionFeatureOrder = [
  'legal',
  'wouldHitWall',
  'wouldHitSelf',
  'wouldHitEnemyBody',
  'wouldLoseHeadOn',
] as const;
export const observationVectorLength = 44;

const directionEncoding: Record<Direction, number> = {
  up: 0,
  down: 1,
  left: 2,
  right: 3,
};

export type EnvRewardBreakdown = {
  win: number;
  loss: number;
  death: number;
  food_gained: number;
  survival_step: number;
};

export type ImmediateActionFeatures = {
  action: EnvAction;
  legal: boolean;
  wouldHitWall: boolean;
  wouldHitSelf: boolean;
  wouldHitEnemyBody: boolean;
  wouldLoseHeadOn: boolean;
};

export type EnvResetResult = {
  done: false;
  truncated: false;
  observationVersion: typeof observationVersion;
  effectiveSeed: number;
  observations: Record<PlayerId, number[]>;
  actionMasks: Record<PlayerId, boolean[]>;
};

export type EnvStepResult = {
  done: boolean;
  truncated: false;
  rewards: Record<PlayerId, number>;
  observations: Record<PlayerId, number[]>;
  actionMasks: Record<PlayerId, boolean[]>;
  info: {
    winner: PlayerId | 'draw' | null;
    rewardBreakdown: Record<PlayerId, EnvRewardBreakdown>;
  };
};

export type EnvReplayDecisionStep = {
  clockMs: number;
  resolveAtMs: number;
  actions: Record<PlayerId, EnvAction>;
};

export type EnvReplayArtifact = {
  effectiveSeed: number;
  decisionSteps: EnvReplayDecisionStep[];
  replayScript: ReplayScript;
  finalOutcome: {
    done: boolean;
    truncated: false;
    winner: PlayerId | 'draw' | null;
    phase: SimulatorSnapshot['phase'];
    remainingMs: number;
  };
  finalSnapshot: SimulatorSnapshot;
};

type RewardWeights = {
  win: number;
  loss: number;
  death: number;
  food_gained: number;
  survival_step: number;
};

type SnakeMlEnvironmentOptions = {
  testMode?: boolean;
  defaultSeed?: number;
  rewardWeights?: Partial<RewardWeights>;
};

export const defaultEnvRewardWeights: Readonly<RewardWeights> = {
  win: 1,
  loss: -1,
  death: -0.2,
  food_gained: 0.1,
  survival_step: 0,
};

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    throw new Error(`Expected a finite numeric seed, received ${seed}`);
  }

  return Math.trunc(seed) >>> 0;
}

function actionToDirection(action: EnvAction): Direction | null {
  return action === 'stay' ? null : action;
}

function isEnvAction(value: unknown): value is EnvAction {
  return typeof value === 'string' && EnvActionOrder.includes(value as EnvAction);
}

function createEmptyRewardBreakdown(): EnvRewardBreakdown {
  return {
    win: 0,
    loss: 0,
    death: 0,
    food_gained: 0,
    survival_step: 0,
  };
}

function cellKey(cell: { x: number; y: number }): string {
  return `${cell.x},${cell.y}`;
}

function move(cell: { x: number; y: number }, direction: Direction): { x: number; y: number } {
  const vector = directionVectors[direction];
  return { x: cell.x + vector.x, y: cell.y + vector.y };
}

function isInsideBoard(snapshot: SimulatorSnapshot, cell: { x: number; y: number }): boolean {
  return cell.x >= 0 && cell.y >= 0 && cell.x < snapshot.board.width && cell.y < snapshot.board.height;
}

export function getLegalActionMask(snapshot: SimulatorSnapshot, playerId: PlayerId): boolean[] {
  const direction = snapshot.players[playerId].direction;
  return EnvActionOrder.map((action) => action === 'stay' || canUseDirection(direction, action));
}

export function getImmediateActionFeatures(snapshot: SimulatorSnapshot, playerId: PlayerId): ImmediateActionFeatures[] {
  const player = snapshot.players[playerId];
  const opponentId: PlayerId = playerId === 'p1' ? 'p2' : 'p1';
  const opponent = snapshot.players[opponentId];
  const ownTailIndex = player.segments.length - 1;
  const enemyTailIndex = opponent.segments.length - 1;

  return EnvActionOrder.map((action) => {
    const legal = action === 'stay' || canUseDirection(player.direction, action);
    const direction = action === 'stay' ? player.direction : action;
    if (!player.alive || !player.head) {
      return {
        action,
        legal,
        wouldHitWall: false,
        wouldHitSelf: false,
        wouldHitEnemyBody: false,
        wouldLoseHeadOn: false,
      };
    }

    const nextHead = move(player.head, direction);
    const willEatFood = nextHead.x === snapshot.food.x && nextHead.y === snapshot.food.y;
    const selfOccupied = new Set<string>();
    const enemyOccupied = new Set<string>();

    player.segments.forEach((segment, index) => {
      const isVacatingTail = index === ownTailIndex && !willEatFood;
      if (!isVacatingTail) {
        selfOccupied.add(cellKey(segment));
      }
    });

    opponent.segments.forEach((segment, index) => {
      const isVacatingTail = index === enemyTailIndex;
      if (!isVacatingTail) {
        enemyOccupied.add(cellKey(segment));
      }
    });

    const opponentThreats = !opponent.alive || !opponent.head
      ? []
      : (['up', 'down', 'left', 'right'] as Direction[])
          .filter((candidate) => canUseDirection(opponent.direction, candidate))
          .map((candidate) => move(opponent.head!, candidate));

    return {
      action,
      legal,
      wouldHitWall: !isInsideBoard(snapshot, nextHead),
      wouldHitSelf: selfOccupied.has(cellKey(nextHead)),
      wouldHitEnemyBody: enemyOccupied.has(cellKey(nextHead)),
      wouldLoseHeadOn: opponentThreats.some(
        (candidate) =>
          candidate.x === nextHead.x &&
          candidate.y === nextHead.y &&
          opponent.length >= player.length,
      ),
    };
  });
}

export class SnakeMlEnvironment {
  private readonly options: SnakeMlEnvironmentOptions;
  private readonly rewardWeights: RewardWeights;
  private simulator: SnakeSimulator | null = null;
  private effectiveSeed: number | null = null;
  private decisionSteps: EnvReplayDecisionStep[] = [];

  constructor(options: SnakeMlEnvironmentOptions = {}) {
    this.options = options;
    this.rewardWeights = { ...defaultEnvRewardWeights, ...options.rewardWeights };
  }

  reset(seed?: number): EnvResetResult {
    const effectiveSeed =
      seed !== undefined
        ? normalizeSeed(seed)
        : this.options.testMode
          ? normalizeSeed(this.options.defaultSeed ?? DEFAULT_TEST_SEED)
          : normalizeSeed(Math.floor(Math.random() * 0x1_0000_0000));

    this.simulator = new SnakeSimulator({
      randomFactory: createSeededRandomFactory(effectiveSeed),
    });
    this.effectiveSeed = effectiveSeed;
    this.decisionSteps = [];

    this.simulator.startCountdown();
    this.simulator.advanceElapsed(COUNTDOWN_MS);

    return {
      done: false,
      truncated: false,
      observationVersion,
      effectiveSeed,
      observations: this.collectObservations(),
      actionMasks: this.collectActionMasks(),
    };
  }

  step(actions: Record<PlayerId, EnvAction>): EnvStepResult {
    const simulator = this.requireSimulator();
    const before = simulator.snapshot();
    const validatedActions = validateEnvActions(actions);

    if (before.phase === 'finished') {
      throw new Error('Cannot call step() after the environment has reached a terminal state');
    }

    this.decisionSteps.push({
      clockMs: before.clockMs,
      resolveAtMs: before.clockMs + Math.min(simulator.getState().movementMs, simulator.getState().remainingMs),
      actions: {
        p1: validatedActions.p1,
        p2: validatedActions.p2,
      },
    });

    for (const playerId of PLAYER_IDS) {
      const direction = actionToDirection(validatedActions[playerId]);
      if (direction) {
        simulator.submitAction(playerId, direction);
      }
    }

    simulator.advanceElapsed(simulator.getState().movementMs);
    const after = simulator.snapshot();
    const done = after.phase === 'finished';
    const rewardBreakdown = this.computeRewardBreakdowns(before, after);
    const rewards = {
      p1: sumBreakdown(rewardBreakdown.p1),
      p2: sumBreakdown(rewardBreakdown.p2),
    };

    return {
      done,
      truncated: false,
      rewards,
      observations: this.collectObservations(),
      actionMasks: this.collectActionMasks(),
      info: {
        winner: after.winner,
        rewardBreakdown,
      },
    };
  }

  getObservation(playerId: PlayerId): number[] {
    return createObservationVector(this.snapshot(), playerId);
  }

  getActionMask(playerId: PlayerId): boolean[] {
    return getLegalActionMask(this.snapshot(), playerId);
  }

  captureReplayArtifact(): EnvReplayArtifact {
    const snapshot = this.snapshot();
    const replayScript: ReplayScript = {
      seed: this.requireSeed(),
      actions: this.decisionSteps.flatMap((step) =>
        PLAYER_IDS.flatMap((playerId) => {
          const direction = actionToDirection(step.actions[playerId]);
          if (!direction) {
            return [];
          }

          return [
            {
              atMs: Math.max(step.clockMs, step.resolveAtMs - 1),
              playerId,
              direction,
            },
          ];
        }),
      ),
      endAtMs: snapshot.clockMs,
    };

    return {
      effectiveSeed: this.requireSeed(),
      decisionSteps: this.decisionSteps.map((step) => ({
        clockMs: step.clockMs,
        resolveAtMs: step.resolveAtMs,
        actions: { ...step.actions },
      })),
      replayScript,
      finalOutcome: {
        done: snapshot.phase === 'finished',
        truncated: false,
        winner: snapshot.winner,
        phase: snapshot.phase,
        remainingMs: snapshot.remainingMs,
      },
      finalSnapshot: snapshot,
    };
  }

  private collectObservations(): Record<PlayerId, number[]> {
    return {
      p1: this.getObservation('p1'),
      p2: this.getObservation('p2'),
    };
  }

  private collectActionMasks(): Record<PlayerId, boolean[]> {
    return {
      p1: this.getActionMask('p1'),
      p2: this.getActionMask('p2'),
    };
  }

  private computeRewardBreakdowns(
    before: SimulatorSnapshot,
    after: SimulatorSnapshot,
  ): Record<PlayerId, EnvRewardBreakdown> {
    const done = after.phase === 'finished';
    const terminalTransition = before.phase !== 'finished' && done;

    return Object.fromEntries(
      PLAYER_IDS.map((playerId) => {
        const playerBefore = before.players[playerId];
        const playerAfter = after.players[playerId];
        const breakdown = createEmptyRewardBreakdown();
        const foodDelta = playerAfter.score - playerBefore.score;

        if (foodDelta > 0) {
          breakdown.food_gained = foodDelta * this.rewardWeights.food_gained;
        }

        if (playerBefore.alive && !playerAfter.alive) {
          breakdown.death = this.rewardWeights.death;
        }

        if (!done && playerAfter.alive) {
          breakdown.survival_step = this.rewardWeights.survival_step;
        }

        if (terminalTransition && after.winner) {
          if (after.winner === playerId) {
            breakdown.win = this.rewardWeights.win;
          } else if (after.winner !== 'draw') {
            breakdown.loss = this.rewardWeights.loss;
          }
        }

        return [playerId, breakdown];
      }),
    ) as Record<PlayerId, EnvRewardBreakdown>;
  }

  private requireSeed(): number {
    if (this.effectiveSeed === null) {
      throw new Error('Environment must be reset before use');
    }

    return this.effectiveSeed;
  }

  private requireSimulator(): SnakeSimulator {
    if (!this.simulator) {
      throw new Error('Environment must be reset before use');
    }

    return this.simulator;
  }

  private snapshot(): SimulatorSnapshot {
    return this.requireSimulator().snapshot();
  }
}

export function createMlEnvironment(options: SnakeMlEnvironmentOptions = {}): SnakeMlEnvironment {
  return new SnakeMlEnvironment(options);
}

export function createObservationVector(snapshot: SimulatorSnapshot, playerId: PlayerId): number[] {
  const own = snapshot.players[playerId];
  const opponent = snapshot.players[playerId === 'p1' ? 'p2' : 'p1'];
  const ownHead = own.head;
  const opponentHead = opponent.head;
  const foodDx = ownHead ? snapshot.food.x - ownHead.x : 0;
  const foodDy = ownHead ? snapshot.food.y - ownHead.y : 0;

  const observation = [
    ownHead?.x ?? NULL_COORDINATE,
    ownHead?.y ?? NULL_COORDINATE,
    directionEncoding[own.direction],
    directionEncoding[own.pendingDirection],
    own.length,
    own.score,
    own.alive ? 1 : 0,
    own.respawnRemainingMs,
    opponentHead?.x ?? NULL_COORDINATE,
    opponentHead?.y ?? NULL_COORDINATE,
    directionEncoding[opponent.direction],
    directionEncoding[opponent.pendingDirection],
    opponent.length,
    opponent.score,
    opponent.alive ? 1 : 0,
    opponent.respawnRemainingMs,
    foodDx,
    foodDy,
    snapshot.remainingMs,
    ...getImmediateActionFeatures(snapshot, playerId).flatMap((feature) => [
      Number(feature.legal),
      Number(feature.wouldHitWall),
      Number(feature.wouldHitSelf),
      Number(feature.wouldHitEnemyBody),
      Number(feature.wouldLoseHeadOn),
    ]),
  ];

  if (observation.length !== observationVectorLength) {
    throw new Error(`Observation contract drifted: expected length ${observationVectorLength}, received ${observation.length}`);
  }

  return observation;
}

function sumBreakdown(breakdown: EnvRewardBreakdown): number {
  return breakdown.win + breakdown.loss + breakdown.death + breakdown.food_gained + breakdown.survival_step;
}

function validateEnvActions(actions: Record<PlayerId, EnvAction>): Record<PlayerId, EnvAction> {
  if (!actions || typeof actions !== 'object') {
    throw new TypeError('Expected actions to be an object with p1 and p2 EnvAction values');
  }

  const p1 = (actions as Partial<Record<PlayerId, unknown>>).p1;
  const p2 = (actions as Partial<Record<PlayerId, unknown>>).p2;
  if (!isEnvAction(p1) || !isEnvAction(p2)) {
    throw new TypeError(`Expected actions.p1 and actions.p2 to be one of: ${EnvActionOrder.join(', ')}`);
  }

  return { p1, p2 };
}

export function replayEnvironmentArtifact(artifact: EnvReplayArtifact): SimulatorSnapshot {
  const snapshots = runReplay(artifact.replayScript);
  return snapshots.at(-1) ?? artifact.finalSnapshot;
}
