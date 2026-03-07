import { describe, expect, it } from 'vitest';
import { runReplay } from '../core';
import {
  createDefaultEvaluationMatchups,
  createHeuristicPolicy,
  createRandomSafePolicy,
  evaluateEpisode,
  evaluateMatchup,
  passesRandomSafeGate,
} from './eval';
import { EnvActionOrder, SnakeMlEnvironment } from './index';

describe('ml evaluation harness', () => {
  it('random-safe policy always returns a valid masked action', () => {
    const env = new SnakeMlEnvironment();
    const policy = createRandomSafePolicy();
    env.reset(5);
    policy.reset(5, 'p1');

    for (let step = 0; step < 20; step += 1) {
      const actionMask = env.getActionMask('p1');
      const action = policy.selectAction({
        snapshot: env.captureReplayArtifact().finalSnapshot,
        playerId: 'p1',
        actionMask,
      });

      expect(EnvActionOrder).toContain(action);
      expect(actionMask[EnvActionOrder.indexOf(action)]).toBe(true);
      env.step({ p1: action, p2: 'stay' });
    }
  });

  it('produces deterministic seeded batch metrics', () => {
    const seeds = [1, 2, 3, 4, 5, 6];
    const matchup = {
      name: 'heuristic-vs-random-safe',
      p1Policy: createHeuristicPolicy,
      p2Policy: createRandomSafePolicy,
      focusPlayerId: 'p1' as const,
    };

    expect(evaluateMatchup(matchup, seeds)).toEqual(evaluateMatchup(matchup, seeds));
  });

  it('reports the expected seeded heuristic-vs-random-safe metrics', () => {
    const result = evaluateMatchup(
      {
        name: 'heuristic-vs-random-safe',
        p1Policy: createHeuristicPolicy,
        p2Policy: createRandomSafePolicy,
        focusPlayerId: 'p1',
      },
      [1, 2, 3, 4],
    );

    expect(result.metrics).toEqual({
      episodes: 4,
      winRate: 1,
      lossRate: 0,
      drawRate: 0,
      averageScore: 42.75,
      averageReward: 5.225000000000001,
      averageDeaths: 0.25,
      averageSteps: 900,
    });
  });

  it('captures replayable artifacts for flagged losses', () => {
    const result = evaluateMatchup(
      {
        name: 'random-safe-vs-heuristic',
        p1Policy: createRandomSafePolicy,
        p2Policy: createHeuristicPolicy,
        focusPlayerId: 'p1',
      },
      [1, 2, 3],
    );

    expect(result.flaggedEpisodes.length).toBeGreaterThan(0);
    const flagged = result.flaggedEpisodes[0];
    const replayFinal = runReplay(flagged.artifact.replayScript).at(-1);

    expect(replayFinal).toEqual(flagged.artifact.finalSnapshot);
  });

  it('defines a deterministic weak gate against the random-safe baseline', () => {
    const result = evaluateMatchup(
      {
        name: 'heuristic-vs-random-safe',
        p1Policy: createHeuristicPolicy,
        p2Policy: createRandomSafePolicy,
        focusPlayerId: 'p1',
      },
      [1, 2, 3, 4, 5, 6, 7, 8],
    );

    expect(result.metrics.winRate).toBe(1);
    expect(passesRandomSafeGate(result, 0.6)).toBe(true);
  });

  it('ships the default offline evaluation lineup', () => {
    expect(createDefaultEvaluationMatchups().map((matchup) => matchup.name)).toEqual([
      'random-safe-vs-random-safe',
      'heuristic-vs-random-safe',
    ]);
  });

  it('keeps reward breakdowns visible in episode summaries', () => {
    const episode = evaluateEpisode({
      seed: 9,
      p1Policy: createHeuristicPolicy(),
      p2Policy: createRandomSafePolicy(),
    });

    expect(episode.rewardBreakdown.p1.win).toBeGreaterThanOrEqual(0);
    expect(episode.rewardBreakdown.p1.food_gained).toBeGreaterThan(0);
    expect(episode.steps).toBeGreaterThan(0);
  });
});
