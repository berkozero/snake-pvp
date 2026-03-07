import { createDefaultEvaluationMatchups, evaluateMatchup, passesRandomSafeGate } from './ml-eval';

const seeds = [1, 2, 3, 4, 5, 6, 7, 8];

for (const matchup of createDefaultEvaluationMatchups()) {
  const result = evaluateMatchup(matchup, seeds);
  const gate = matchup.name === 'heuristic-vs-random-safe' ? passesRandomSafeGate(result, 0.6) : null;

  process.stdout.write(
    `${JSON.stringify(
      {
        matchup: matchup.name,
        seeds,
        metrics: result.metrics,
        gatePassed: gate,
        flaggedSeeds: result.flaggedEpisodes.map((episode) => episode.seed),
      },
      null,
      2,
    )}\n`,
  );
}
