import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chooseHeuristicDirection, SnakeSimulator, type SimulatorSnapshot } from '@snake/game-core';
import { EnvActionOrder, getImmediateActionFeatures, type EnvAction } from '@snake/game-core/ml';
import type { PlayerId } from '@snake/game-core';

type ReplayArtifact = {
  effectiveSeed: number;
  decisionSteps: Array<{
    clockMs: number;
    resolveAtMs: number;
    actions: Record<PlayerId, EnvAction>;
  }>;
};

function classify(snapshot: SimulatorSnapshot, chosenAction: EnvAction, teacherAction: EnvAction): string[] {
  const features = getImmediateActionFeatures(snapshot, 'p1');
  const selected = features[EnvActionOrder.indexOf(chosenAction)];
  const reasons: string[] = [];
  if (chosenAction !== teacherAction) {
    reasons.push('policy_teacher_divergence');
  }
  if (selected?.wouldHitWall) {
    reasons.push('dies_near_walls');
  }
  if (selected && (selected.wouldHitSelf || selected.wouldHitEnemyBody)) {
    reasons.push('misses_safe_turn');
  }
  if (selected?.wouldLoseHeadOn) {
    reasons.push('bad_head_on_judgment');
  }
  const own = snapshot.players.p1;
  const opp = snapshot.players.p2;
  if (own.respawnRemainingMs > 0 || opp.respawnRemainingMs > 0) {
    reasons.push('respawn_or_chase_state');
  }
  return reasons;
}

async function analyze(flaggedDir: string) {
  const files = Array.from(new Bun.Glob('*.json').scanSync({ cwd: flaggedDir }));
  const totals = new Map<string, number>();
  const perReplay: Array<{ file: string; reasons: Record<string, number> }> = [];

  for (const file of files) {
    const artifact = JSON.parse(await readFile(path.join(flaggedDir, file), 'utf8')) as ReplayArtifact;
    const simulator = new SnakeSimulator();
    simulator.reset(artifact.effectiveSeed);
    simulator.startCountdown();
    simulator.advanceElapsed(simulator.getState().countdownMs);

    const reasonCounts = new Map<string, number>();
    for (const step of artifact.decisionSteps) {
      const snapshot = simulator.snapshot();
      const teacherAction = chooseHeuristicDirection(snapshot, 'p1') as EnvAction;
      const reasons = classify(snapshot, step.actions.p1, teacherAction);
      for (const reason of reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
        totals.set(reason, (totals.get(reason) ?? 0) + 1);
      }
      if (step.actions.p1 !== 'stay') {
        simulator.submitAction('p1', step.actions.p1);
      }
      if (step.actions.p2 !== 'stay') {
        simulator.submitAction('p2', step.actions.p2);
      }
      simulator.advanceElapsed(simulator.getState().movementMs);
    }

    perReplay.push({
      file,
      reasons: Object.fromEntries([...reasonCounts.entries()].sort((a, b) => b[1] - a[1])),
    });
  }

  return {
    flaggedReplayCount: files.length,
    topReasons: [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count })),
    exampleReplays: perReplay.slice(0, 10),
  };
}

const flaggedDir = process.argv[2];
if (!flaggedDir) {
  throw new Error('Usage: bun tools/ai/scripts/analyze-flagged-losses.ts <flaggedDir>');
}
const summary = await analyze(path.resolve(flaggedDir));
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
