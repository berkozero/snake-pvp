import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chooseHeuristicDirection, SnakeSimulator, type SimulatorSnapshot } from '@snake/game-core';
import { EnvActionOrder, createObservationVector, getImmediateActionFeatures, getLegalActionMask, observationVersion, type EnvAction } from '@snake/game-core/ml';
import { datasetGeneratorVersion, trainingActionOrder, trainingObservationLength, trainingObservationVersion } from './training-contract';
import type { PlayerId } from '@snake/game-core';

type ReplayArtifact = {
  effectiveSeed: number;
  decisionSteps: Array<{
    clockMs: number;
    resolveAtMs: number;
    actions: Record<PlayerId, EnvAction>;
  }>;
};

type HardStateSample = {
  observation: number[];
  actionMask: boolean[];
  teacherAction: EnvAction;
  seed: number;
  playerId: 'p1';
  stepIndex: number;
  observationVersion: typeof trainingObservationVersion;
  hardReasons: string[];
  sourceReplay: string;
};

type BucketId = 'all' | 'respawn-chase' | 'tactical-divergence' | 'safety-critical';

const bucketOrder: BucketId[] = ['all', 'respawn-chase', 'tactical-divergence', 'safety-critical'];

function actionRiskTags(snapshot: SimulatorSnapshot, action: EnvAction, playerId: PlayerId): string[] {
  const features = getImmediateActionFeatures(snapshot, playerId);
  const selected = features[EnvActionOrder.indexOf(action)];
  if (!selected) {
    return [];
  }
  const tags: string[] = [];
  if (selected.wouldHitWall) {
    tags.push('dies_near_walls');
  }
  if (selected.wouldHitSelf || selected.wouldHitEnemyBody) {
    tags.push('misses_safe_turn');
  }
  if (selected.wouldLoseHeadOn) {
    tags.push('bad_head_on_judgment');
  }
  return tags;
}

function classifyHardState(snapshot: SimulatorSnapshot, chosenAction: EnvAction, teacherAction: EnvAction): string[] {
  const reasons = new Set<string>();
  if (chosenAction !== teacherAction) {
    reasons.add('policy_teacher_divergence');
  }

  for (const tag of actionRiskTags(snapshot, chosenAction, 'p1')) {
    reasons.add(tag);
  }

  const ownHead = snapshot.players.p1.head;
  if (ownHead) {
    const chosenDirection = chosenAction === 'stay' ? snapshot.players.p1.direction : chosenAction;
    const teacherDirection = teacherAction === 'stay' ? snapshot.players.p1.direction : teacherAction;
    const chosenNextHead = {
      x: ownHead.x + (chosenDirection === 'left' ? -1 : chosenDirection === 'right' ? 1 : 0),
      y: ownHead.y + (chosenDirection === 'up' ? -1 : chosenDirection === 'down' ? 1 : 0),
    };
    const teacherNextHead = {
      x: ownHead.x + (teacherDirection === 'left' ? -1 : teacherDirection === 'right' ? 1 : 0),
      y: ownHead.y + (teacherDirection === 'up' ? -1 : teacherDirection === 'down' ? 1 : 0),
    };
    const chosenFoodDistance = Math.abs(chosenNextHead.x - snapshot.food.x) + Math.abs(chosenNextHead.y - snapshot.food.y);
    const teacherFoodDistance = Math.abs(teacherNextHead.x - snapshot.food.x) + Math.abs(teacherNextHead.y - snapshot.food.y);
    if (chosenFoodDistance < teacherFoodDistance && actionRiskTags(snapshot, chosenAction, 'p1').length > 0) {
      reasons.add('overcommits_to_food');
    }
  }

  const own = snapshot.players.p1;
  const opp = snapshot.players.p2;
  if (own.respawnRemainingMs > 0 || opp.respawnRemainingMs > 0) {
    reasons.add('respawn_or_chase_state');
  }

  return [...reasons];
}

function resolveBuckets(reasons: string[]): BucketId[] {
  const buckets = new Set<BucketId>(['all']);
  if (reasons.includes('respawn_or_chase_state')) {
    buckets.add('respawn-chase');
  }
  if (reasons.includes('policy_teacher_divergence')) {
    buckets.add('tactical-divergence');
  }
  if (
    reasons.includes('misses_safe_turn') ||
    reasons.includes('dies_near_walls') ||
    reasons.includes('bad_head_on_judgment') ||
    reasons.includes('overcommits_to_food')
  ) {
    buckets.add('safety-critical');
  }
  return bucketOrder.filter((bucket) => buckets.has(bucket));
}

async function writeBucketDataset(
  outputRoot: string,
  bucketId: BucketId,
  sampleLines: string[],
  episodeCount: number,
  sourceFlaggedDir: string,
) {
  const bucketDir = path.join(outputRoot, bucketId);
  await mkdir(bucketDir, { recursive: true });
  const manifest = {
    datasetId: path.basename(bucketDir),
    createdAt: new Date().toISOString(),
    teacherPolicyName: 'heuristic',
    observationVersion: trainingObservationVersion,
    observationLength: trainingObservationLength,
    actionOrder: trainingActionOrder,
    seedSetId: `flagged-hard-states-${bucketId}`,
    seeds: [],
    episodeCount,
    sampleCount: sampleLines.length,
    generatorVersion: `${datasetGeneratorVersion}-hard-states-v2`,
    sourceFlaggedDir,
    bucketId,
  };
  await writeFile(path.join(bucketDir, 'samples.jsonl'), sampleLines.length > 0 ? `${sampleLines.join('\n')}\n` : '', 'utf8');
  await writeFile(path.join(bucketDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

async function extractHardStates(options: { flaggedDir: string; outputDir: string }) {
  const flaggedDir = path.resolve(options.flaggedDir);
  const outputDir = path.resolve(options.outputDir);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const sampleLinesByBucket = new Map<BucketId, string[]>(bucketOrder.map((bucketId) => [bucketId, []]));
  const sources = Array.from(new Bun.Glob('*.json').scanSync({ cwd: flaggedDir }));

  for (const fileName of sources) {
    const artifact = JSON.parse(await readFile(path.join(flaggedDir, fileName), 'utf8')) as ReplayArtifact;
    const simulator = new SnakeSimulator();
    simulator.reset(artifact.effectiveSeed);
    simulator.startCountdown();
    simulator.advanceElapsed(simulator.getState().countdownMs);

    artifact.decisionSteps.forEach((step, stepIndex) => {
      const snapshot = simulator.snapshot();
      const teacherAction = chooseHeuristicDirection(snapshot, 'p1') as EnvAction;
      const hardReasons = classifyHardState(snapshot, step.actions.p1, teacherAction);
      if (hardReasons.length > 0) {
        const sample: HardStateSample = {
          observation: createObservationVector(snapshot, 'p1'),
          actionMask: getLegalActionMask(snapshot, 'p1'),
          teacherAction,
          seed: artifact.effectiveSeed,
          playerId: 'p1',
          stepIndex,
          observationVersion,
          hardReasons,
          sourceReplay: fileName,
        };
        if (sample.observation.length !== trainingObservationLength) {
          throw new Error(`Hard-state observation length drifted for ${fileName}`);
        }
        const encoded = JSON.stringify(sample);
        for (const bucketId of resolveBuckets(hardReasons)) {
          sampleLinesByBucket.get(bucketId)!.push(encoded);
        }
      }

      if (step.actions.p1 !== 'stay') {
        simulator.submitAction('p1', step.actions.p1);
      }
      if (step.actions.p2 !== 'stay') {
        simulator.submitAction('p2', step.actions.p2);
      }
      simulator.advanceElapsed(simulator.getState().movementMs);
    });
  }

  const manifests = await Promise.all(
    bucketOrder.map((bucketId) =>
      writeBucketDataset(outputDir, bucketId, sampleLinesByBucket.get(bucketId) ?? [], sources.length, flaggedDir),
    ),
  );

  const summary = {
    outputDir,
    sourceFlaggedDir: flaggedDir,
    bucketCounts: Object.fromEntries(manifests.map((manifest) => [manifest.bucketId, manifest.sampleCount])),
    manifests,
  };
  await writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}

function parseArgs(argv: string[]): { flaggedDir: string; outputDir: string } {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${token}`);
    }
    args.set(token.slice(2), value);
    index += 1;
  }
  const flaggedDir = args.get('flaggedDir');
  const outputDir = args.get('outputDir');
  if (!flaggedDir || !outputDir) {
    throw new Error('Usage: bun tools/ai/scripts/extract-hard-states.ts --flaggedDir <dir> --outputDir <dir>');
  }
  return { flaggedDir, outputDir };
}

if (import.meta.main) {
  const summary = await extractHardStates(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
