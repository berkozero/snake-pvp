import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHeuristicPolicy } from '@snake/game-core/ml/eval';
import { EnvActionOrder, SnakeMlEnvironment, type EnvAction } from '@snake/game-core/ml';
import type { PlayerId } from '@snake/game-core';
import {
  datasetGeneratorVersion,
  getSeedSet,
  trainingActionOrder,
  trainingObservationLength,
  trainingObservationVersion,
} from './training-contract';

const PLAYER_IDS: PlayerId[] = ['p1', 'p2'];

export type DatasetSample = {
  observation: number[];
  actionMask: boolean[];
  teacherAction: EnvAction;
  seed: number;
  playerId: PlayerId;
  stepIndex: number;
  observationVersion: typeof trainingObservationVersion;
};

export type DatasetManifest = {
  datasetId: string;
  createdAt: string;
  teacherPolicyName: string;
  observationVersion: typeof trainingObservationVersion;
  observationLength: typeof trainingObservationLength;
  actionOrder: typeof trainingActionOrder;
  seedSetId: string;
  seeds: number[];
  episodeCount: number;
  sampleCount: number;
  generatorVersion: string;
};

export type GenerateDatasetOptions = {
  seedSetId: string;
  outputDir: string;
  maxEpisodes?: number;
  createdAt?: string;
};

function parseAction(value: string): EnvAction {
  if (!EnvActionOrder.includes(value as EnvAction)) {
    throw new Error(`Teacher produced unsupported action: ${value}`);
  }

  return value as EnvAction;
}

function datasetIdFromOutputDir(outputDir: string): string {
  const datasetId = path.basename(path.resolve(outputDir));
  if (!datasetId) {
    throw new Error(`Unable to derive datasetId from output directory: ${outputDir}`);
  }
  return datasetId;
}

function validateSample(sample: DatasetSample): void {
  if (sample.observationVersion !== trainingObservationVersion) {
    throw new Error(`Sample observationVersion drifted: expected ${trainingObservationVersion}, received ${sample.observationVersion}`);
  }

  if (sample.observation.length !== trainingObservationLength) {
    throw new Error(`Sample observation length drifted: expected ${trainingObservationLength}, received ${sample.observation.length}`);
  }

  if (sample.actionMask.length !== trainingActionOrder.length) {
    throw new Error(`Sample actionMask length drifted: expected ${trainingActionOrder.length}, received ${sample.actionMask.length}`);
  }

  if (!trainingActionOrder.includes(sample.teacherAction)) {
    throw new Error(`Sample teacherAction drifted: received ${sample.teacherAction}`);
  }
}

export async function generateDataset(options: GenerateDatasetOptions): Promise<{
  manifest: DatasetManifest;
  samplesPath: string;
  manifestPath: string;
}> {
  const allSeeds = getSeedSet(options.seedSetId);
  const seeds = options.maxEpisodes !== undefined ? allSeeds.slice(0, options.maxEpisodes) : allSeeds;
  const teacherPolicy = createHeuristicPolicy();
  const env = new SnakeMlEnvironment();
  const outputDir = path.resolve(options.outputDir);
  const datasetId = datasetIdFromOutputDir(outputDir);
  const samplesPath = path.join(outputDir, 'samples.jsonl');
  const manifestPath = path.join(outputDir, 'manifest.json');

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const sampleLines: string[] = [];
  let sampleCount = 0;

  for (const seed of seeds) {
    env.reset(seed);
    teacherPolicy.reset(seed, 'p1');
    teacherPolicy.reset(seed, 'p2');

    let stepIndex = 0;
    let done = false;
    while (!done) {
      const snapshot = env.captureReplayArtifact().finalSnapshot;
      const actions = {} as Record<PlayerId, EnvAction>;

      for (const playerId of PLAYER_IDS) {
        const sample: DatasetSample = {
          observation: env.getObservation(playerId),
          actionMask: env.getActionMask(playerId),
          teacherAction: parseAction(
            teacherPolicy.selectAction({
              snapshot,
              playerId,
              actionMask: env.getActionMask(playerId),
            }),
          ),
          seed,
          playerId,
          stepIndex,
          observationVersion: trainingObservationVersion,
        };
        validateSample(sample);
        sampleLines.push(JSON.stringify(sample));
        sampleCount += 1;
        actions[playerId] = sample.teacherAction;
      }

      done = env.step(actions).done;
      stepIndex += 1;
    }
  }

  const manifest: DatasetManifest = {
    datasetId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    teacherPolicyName: teacherPolicy.name,
    observationVersion: trainingObservationVersion,
    observationLength: trainingObservationLength,
    actionOrder: trainingActionOrder,
    seedSetId: options.seedSetId,
    seeds,
    episodeCount: seeds.length,
    sampleCount,
    generatorVersion: datasetGeneratorVersion,
  };

  await writeFile(samplesPath, sampleLines.length > 0 ? `${sampleLines.join('\n')}\n` : '', 'utf8');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return { manifest, samplesPath, manifestPath };
}

export async function loadDatasetManifest(datasetDir: string): Promise<DatasetManifest> {
  const manifestPath = path.join(path.resolve(datasetDir), 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DatasetManifest;
  return manifest;
}

export async function datasetExists(datasetDir: string): Promise<boolean> {
  try {
    const info = await stat(datasetDir);
    return info.isDirectory();
  } catch {
    return false;
  }
}
