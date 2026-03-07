import { chooseHeuristicDirection, createSeededRandom, type PlayerId } from '@snake/game-core';
import type { SimulatorSnapshot } from '@snake/game-core';
import {
  EnvActionOrder,
  SnakeMlEnvironment,
  getImmediateActionFeatures,
  type EnvAction,
  type EnvReplayArtifact,
  type EnvRewardBreakdown,
} from '@snake/game-core/ml';

const PLAYER_IDS: PlayerId[] = ['p1', 'p2'];

export type MlPolicyInput = {
  snapshot: SimulatorSnapshot;
  playerId: PlayerId;
  actionMask: boolean[];
};

export type MlPolicy = {
  name: string;
  reset(seed: number, playerId: PlayerId): void;
  selectAction(input: MlPolicyInput): EnvAction;
};

export type EvaluationEpisodeResult = {
  seed: number;
  winner: PlayerId | 'draw' | null;
  steps: number;
  totalRewards: Record<PlayerId, number>;
  rewardBreakdown: Record<PlayerId, EnvRewardBreakdown>;
  scores: Record<PlayerId, number>;
  deathCount: Record<PlayerId, number>;
  replayArtifact: EnvReplayArtifact;
};

export type EvaluationMetrics = {
  episodes: number;
  winRate: number;
  lossRate: number;
  drawRate: number;
  averageScore: number;
  averageReward: number;
  averageDeaths: number;
  averageSteps: number;
};

export type EvaluationBatchResult = {
  matchupName: string;
  focusPlayerId: PlayerId;
  seeds: number[];
  metrics: EvaluationMetrics;
  episodes: EvaluationEpisodeResult[];
  flaggedEpisodes: EvaluationFlaggedEpisode[];
};

export type EvaluationMatchup = {
  name: string;
  p1Policy: () => MlPolicy;
  p2Policy: () => MlPolicy;
  focusPlayerId?: PlayerId;
};

export type EvaluationFlaggedEpisode = {
  seed: number;
  reason: 'focus_loss' | 'draw';
  artifact: EnvReplayArtifact;
};

function cloneBreakdown(): EnvRewardBreakdown {
  return {
    win: 0,
    loss: 0,
    death: 0,
    food_gained: 0,
    survival_step: 0,
  };
}

function addBreakdown(target: EnvRewardBreakdown, next: EnvRewardBreakdown): void {
  target.win += next.win;
  target.loss += next.loss;
  target.death += next.death;
  target.food_gained += next.food_gained;
  target.survival_step += next.survival_step;
}

export function createRandomSafePolicy(): MlPolicy {
  let random = createSeededRandom(1);

  return {
    name: 'random-safe',
    reset(seed, playerId) {
      const salt = playerId === 'p1' ? 0x9e3779b9 : 0x7f4a7c15;
      random = createSeededRandom((seed ^ salt) >>> 0);
    },
    selectAction({ snapshot, playerId, actionMask }) {
      const features = getImmediateActionFeatures(snapshot, playerId);
      const safe = features
        .filter(
          (feature) =>
            actionMask[EnvActionOrder.indexOf(feature.action)] &&
            !feature.wouldHitWall &&
            !feature.wouldHitSelf &&
            !feature.wouldHitEnemyBody &&
            !feature.wouldLoseHeadOn,
        )
        .map((feature) => feature.action);

      if (safe.length > 0) {
        return safe[Math.floor(random() * safe.length)];
      }

      const legal = EnvActionOrder.filter((action, index) => actionMask[index]);
      return legal[Math.floor(random() * legal.length)] ?? 'stay';
    },
  };
}

export function createHeuristicPolicy(): MlPolicy {
  return {
    name: 'heuristic',
    reset() {},
    selectAction({ snapshot, playerId }) {
      return chooseHeuristicDirection(snapshot, playerId);
    },
  };
}

export function evaluateEpisode(options: {
  seed: number;
  p1Policy: MlPolicy;
  p2Policy: MlPolicy;
}): EvaluationEpisodeResult {
  const env = new SnakeMlEnvironment();
  env.reset(options.seed);
  options.p1Policy.reset(options.seed, 'p1');
  options.p2Policy.reset(options.seed, 'p2');

  const totalRewards: Record<PlayerId, number> = { p1: 0, p2: 0 };
  const rewardBreakdown: Record<PlayerId, EnvRewardBreakdown> = {
    p1: cloneBreakdown(),
    p2: cloneBreakdown(),
  };
  const deathCount: Record<PlayerId, number> = { p1: 0, p2: 0 };

  let steps = 0;
  let done = false;

  while (!done) {
    const snapshot = env.captureReplayArtifact().finalSnapshot;
    const actions = {
      p1: options.p1Policy.selectAction({
        snapshot,
        playerId: 'p1',
        actionMask: env.getActionMask('p1'),
      }),
      p2: options.p2Policy.selectAction({
        snapshot,
        playerId: 'p2',
        actionMask: env.getActionMask('p2'),
      }),
    } satisfies Record<PlayerId, EnvAction>;

    const result = env.step(actions);
    steps += 1;
    done = result.done;

    for (const playerId of PLAYER_IDS) {
      totalRewards[playerId] += result.rewards[playerId];
      addBreakdown(rewardBreakdown[playerId], result.info.rewardBreakdown[playerId]);
      if (result.info.rewardBreakdown[playerId].death !== 0) {
        deathCount[playerId] += 1;
      }
    }
  }

  const artifact = env.captureReplayArtifact();
  return {
    seed: options.seed,
    winner: artifact.finalOutcome.winner,
    steps,
    totalRewards,
    rewardBreakdown,
    scores: {
      p1: artifact.finalSnapshot.players.p1.score,
      p2: artifact.finalSnapshot.players.p2.score,
    },
    deathCount,
    replayArtifact: artifact,
  };
}

export function evaluateMatchup(matchup: EvaluationMatchup, seeds: number[]): EvaluationBatchResult {
  const focusPlayerId = matchup.focusPlayerId ?? 'p1';
  const episodes = seeds.map((seed) =>
    evaluateEpisode({
      seed,
      p1Policy: matchup.p1Policy(),
      p2Policy: matchup.p2Policy(),
    }),
  );

  const wins = episodes.filter((episode) => episode.winner === focusPlayerId).length;
  const draws = episodes.filter((episode) => episode.winner === 'draw').length;
  const losses = episodes.length - wins - draws;

  return {
    matchupName: matchup.name,
    focusPlayerId,
    seeds: [...seeds],
    metrics: {
      episodes: episodes.length,
      winRate: wins / episodes.length,
      lossRate: losses / episodes.length,
      drawRate: draws / episodes.length,
      averageScore:
        episodes.reduce((sum, episode) => sum + episode.scores[focusPlayerId], 0) / episodes.length,
      averageReward:
        episodes.reduce((sum, episode) => sum + episode.totalRewards[focusPlayerId], 0) / episodes.length,
      averageDeaths:
        episodes.reduce((sum, episode) => sum + episode.deathCount[focusPlayerId], 0) / episodes.length,
      averageSteps: episodes.reduce((sum, episode) => sum + episode.steps, 0) / episodes.length,
    },
    episodes,
    flaggedEpisodes: episodes.flatMap<EvaluationFlaggedEpisode>((episode) => {
      if (episode.winner === 'draw') {
        return [{ seed: episode.seed, reason: 'draw' as const, artifact: episode.replayArtifact }];
      }
      if (episode.winner !== focusPlayerId) {
        return [{ seed: episode.seed, reason: 'focus_loss' as const, artifact: episode.replayArtifact }];
      }
      return [];
    }),
  };
}

export function passesRandomSafeGate(result: EvaluationBatchResult, minimumWinRate = 0.55): boolean {
  return result.metrics.winRate >= minimumWinRate;
}

export function createDefaultEvaluationMatchups(): EvaluationMatchup[] {
  return [
    {
      name: 'random-safe-vs-random-safe',
      p1Policy: createRandomSafePolicy,
      p2Policy: createRandomSafePolicy,
      focusPlayerId: 'p1',
    },
    {
      name: 'heuristic-vs-random-safe',
      p1Policy: createHeuristicPolicy,
      p2Policy: createRandomSafePolicy,
      focusPlayerId: 'p1',
    },
  ];
}
