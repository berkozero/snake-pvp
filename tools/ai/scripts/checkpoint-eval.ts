import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHeuristicPolicy, createRandomSafePolicy, type EvaluationBatchResult, type EvaluationEpisodeResult } from './ml-eval';
import { SnakeMlEnvironment, type EnvAction, type EnvReplayArtifact } from '@snake/game-core/ml';
import type { PlayerId } from '@snake/game-core';
import { getSeedSet, trainingActionOrder, trainingObservationLength, trainingObservationVersion } from './training-contract';

const PLAYER_IDS: PlayerId[] = ['p1', 'p2'];
const SCRIPTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const AI_ROOT = path.resolve(SCRIPTS_ROOT, '..');
const LOCAL_ARTIFACTS_ROOT = path.join(AI_ROOT, '.local', 'artifacts');

export type CheckpointMetadata = {
  runId: string;
  createdAt: string;
  modelType: string;
  inputSize: number;
  hiddenSize: number;
  hiddenSizes?: number[];
  outputSize: number;
  actionOrder: string[];
  observationVersion: number;
  trainDatasetId: string;
  supplementalDatasetId?: string | null;
  supplementalWeight?: number | null;
  supplementalDatasets?: Array<{
    datasetId: string;
    seedSetId: string;
    sampleCount: number;
    weight: number;
  }>;
  validationSeedSetId: string;
  gateSeedSetId?: string;
  trainerStack: 'python-pytorch';
  exportVersion?: string;
  checkpointOrigin?: 'imitation' | 'rl-ppo';
  lastRlUpdate?: number;
};

type RuntimeRequest =
  | { id: string; type: 'load'; checkpointDir: string }
  | { id: string; type: 'act'; observation: number[]; actionMask: boolean[] };

type RuntimeResponse =
  | { id: string; type: 'loaded'; metadata: CheckpointMetadata }
  | { id: string; type: 'action'; action: EnvAction }
  | { id: string; type: 'error'; error: string };

type OpponentPolicy = ReturnType<typeof createRandomSafePolicy> | ReturnType<typeof createHeuristicPolicy>;

type MatchupTarget = 'random-safe' | 'heuristic';

export type CheckpointEvaluationSummary = EvaluationBatchResult & {
  checkpointRunId: string;
  checkpointDir: string;
  matchupTarget: MatchupTarget;
  seedSetId: string;
};

class PythonPolicyRuntime {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, (value: RuntimeResponse) => void>();
  private nextId = 0;
  private buffer = '';

  constructor() {
    this.proc = spawn('python3', ['python/policy_runtime.py'], {
      cwd: AI_ROOT,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newlineIndex = this.buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line) {
          const response = JSON.parse(line) as RuntimeResponse;
          this.pending.get(response.id)?.(response);
          this.pending.delete(response.id);
        }
        newlineIndex = this.buffer.indexOf('\n');
      }
    });
  }

  async load(checkpointDir: string): Promise<CheckpointMetadata> {
    const response = await this.request({ type: 'load', checkpointDir: path.resolve(checkpointDir) });
    if (response.type !== 'loaded') {
      throw new Error(response.error);
    }
    return response.metadata;
  }

  async selectAction(observation: number[], actionMask: boolean[]): Promise<EnvAction> {
    const response = await this.request({ type: 'act', observation, actionMask });
    if (response.type !== 'action') {
      throw new Error(response.error);
    }
    return response.action;
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    await new Promise<void>((resolve) => {
      this.proc.once('exit', () => resolve());
    });
  }

  private async request(request: Omit<RuntimeRequest, 'id'>): Promise<RuntimeResponse> {
    const id = `req-${this.nextId++}`;
    const response = new Promise<RuntimeResponse>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.proc.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
    return response;
  }
}

async function loadMetadata(checkpointDir: string): Promise<CheckpointMetadata> {
  const metadata = JSON.parse(await readFile(path.join(checkpointDir, 'metadata.json'), 'utf8')) as CheckpointMetadata;
  if (!metadata.modelType.startsWith('mlp-')) {
    throw new Error(`Unsupported modelType: ${metadata.modelType}`);
  }
  if (metadata.inputSize !== trainingObservationLength) {
    throw new Error(`Checkpoint inputSize drifted: expected ${trainingObservationLength}, received ${metadata.inputSize}`);
  }
  if (metadata.outputSize !== trainingActionOrder.length) {
    throw new Error(`Checkpoint outputSize drifted: expected ${trainingActionOrder.length}, received ${metadata.outputSize}`);
  }
  if (metadata.observationVersion !== trainingObservationVersion) {
    throw new Error(`Checkpoint observationVersion drifted: expected ${trainingObservationVersion}, received ${metadata.observationVersion}`);
  }
  if (JSON.stringify(metadata.actionOrder) !== JSON.stringify(trainingActionOrder)) {
    throw new Error('Checkpoint actionOrder drifted from the frozen training contract');
  }
  return metadata;
}

export async function resolveCheckpointDir(checkpointDir: string): Promise<string> {
  const absoluteDir = path.resolve(checkpointDir);
  const policyMetadataPath = path.join(absoluteDir, 'policy', 'metadata.json');
  if (existsSync(policyMetadataPath)) {
    return path.join(absoluteDir, 'policy');
  }
  return absoluteDir;
}

function createOpponentPolicy(target: MatchupTarget): OpponentPolicy {
  return target === 'random-safe' ? createRandomSafePolicy() : createHeuristicPolicy();
}

async function evaluateEpisode(seed: number, runtime: PythonPolicyRuntime, target: MatchupTarget): Promise<EvaluationEpisodeResult> {
  const env = new SnakeMlEnvironment();
  const opponent = createOpponentPolicy(target);
  env.reset(seed);
  opponent.reset(seed, 'p2');

  let steps = 0;
  let done = false;
  const totalRewards: Record<PlayerId, number> = { p1: 0, p2: 0 };
  const rewardBreakdown = {
    p1: { win: 0, loss: 0, death: 0, food_gained: 0, survival_step: 0 },
    p2: { win: 0, loss: 0, death: 0, food_gained: 0, survival_step: 0 },
  };
  const deathCount: Record<PlayerId, number> = { p1: 0, p2: 0 };

  while (!done) {
    const snapshot = env.captureReplayArtifact().finalSnapshot;
    const p1Action = await runtime.selectAction(env.getObservation('p1'), env.getActionMask('p1'));
    const p2Action = opponent.selectAction({
      snapshot,
      playerId: 'p2',
      actionMask: env.getActionMask('p2'),
    });

    const result = env.step({ p1: p1Action, p2: p2Action });
    done = result.done;
    steps += 1;

    for (const playerId of PLAYER_IDS) {
      totalRewards[playerId] += result.rewards[playerId];
      const next = result.info.rewardBreakdown[playerId];
      rewardBreakdown[playerId].win += next.win;
      rewardBreakdown[playerId].loss += next.loss;
      rewardBreakdown[playerId].death += next.death;
      rewardBreakdown[playerId].food_gained += next.food_gained;
      rewardBreakdown[playerId].survival_step += next.survival_step;
      if (next.death !== 0) {
        deathCount[playerId] += 1;
      }
    }
  }

  const replayArtifact = env.captureReplayArtifact();
  return {
    seed,
    winner: replayArtifact.finalOutcome.winner,
    steps,
    totalRewards,
    rewardBreakdown,
    scores: {
      p1: replayArtifact.finalSnapshot.players.p1.score,
      p2: replayArtifact.finalSnapshot.players.p2.score,
    },
    deathCount,
    replayArtifact,
  };
}

export async function evaluateCheckpoint(options: {
  checkpointDir: string;
  matchupTarget: MatchupTarget;
  seedSetId: string;
  outputDir?: string;
}): Promise<CheckpointEvaluationSummary> {
  const checkpointDir = await resolveCheckpointDir(options.checkpointDir);
  const metadata = await loadMetadata(checkpointDir);
  const runtime = new PythonPolicyRuntime();
  try {
    await runtime.load(checkpointDir);
    const seeds = getSeedSet(options.seedSetId);
    const episodes: EvaluationEpisodeResult[] = [];
    for (const seed of seeds) {
      episodes.push(await evaluateEpisode(seed, runtime, options.matchupTarget));
    }

    const wins = episodes.filter((episode) => episode.winner === 'p1').length;
    const draws = episodes.filter((episode) => episode.winner === 'draw').length;
    const losses = episodes.length - wins - draws;
    const flaggedEpisodes = episodes.flatMap((episode) => {
      if (episode.winner === 'draw') {
        return [{ seed: episode.seed, reason: 'draw' as const, artifact: episode.replayArtifact }];
      }
      if (episode.winner !== 'p1') {
        return [{ seed: episode.seed, reason: 'focus_loss' as const, artifact: episode.replayArtifact }];
      }
      return [];
    });

    const summary: CheckpointEvaluationSummary = {
      checkpointRunId: metadata.runId,
      checkpointDir,
      matchupTarget: options.matchupTarget,
      seedSetId: options.seedSetId,
      matchupName: `trained-policy-vs-${options.matchupTarget}`,
      focusPlayerId: 'p1',
      seeds,
      metrics: {
        episodes: episodes.length,
        winRate: wins / episodes.length,
        lossRate: losses / episodes.length,
        drawRate: draws / episodes.length,
        averageScore: episodes.reduce((sum, episode) => sum + episode.scores.p1, 0) / episodes.length,
        averageReward: episodes.reduce((sum, episode) => sum + episode.totalRewards.p1, 0) / episodes.length,
        averageDeaths: episodes.reduce((sum, episode) => sum + episode.deathCount.p1, 0) / episodes.length,
        averageSteps: episodes.reduce((sum, episode) => sum + episode.steps, 0) / episodes.length,
      },
      episodes,
      flaggedEpisodes,
    };

    const baseOutputDir = options.outputDir
      ? path.resolve(options.outputDir)
      : path.join(LOCAL_ARTIFACTS_ROOT, 'evals', metadata.runId, `${options.matchupTarget}-${options.seedSetId}`);
    await rm(baseOutputDir, { recursive: true, force: true });
    await mkdir(path.join(baseOutputDir, 'flagged'), { recursive: true });
    await writeFile(path.join(baseOutputDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    await Promise.all(
      flaggedEpisodes.map((flagged) =>
        writeFile(
          path.join(baseOutputDir, 'flagged', `${flagged.seed}-${flagged.reason}.json`),
          JSON.stringify(flagged.artifact as EnvReplayArtifact, null, 2),
          'utf8',
        ),
      ),
    );

    return summary;
  } finally {
    await runtime.close();
  }
}

function parseArgs(argv: string[]): {
  checkpointDir: string;
  matchupTarget: MatchupTarget;
  seedSetId: string;
  outputDir?: string;
} {
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

  const checkpointDir = args.get('checkpointDir');
  const matchupTarget = args.get('matchupTarget');
  const seedSetId = args.get('seedSetId');
  if (!checkpointDir || !matchupTarget || !seedSetId) {
    throw new Error('Usage: bun tools/ai/scripts/checkpoint-eval.ts --checkpointDir <dir> --matchupTarget <random-safe|heuristic> --seedSetId <id> [--outputDir <dir>]');
  }
  if (matchupTarget !== 'random-safe' && matchupTarget !== 'heuristic') {
    throw new Error(`Unsupported matchupTarget: ${matchupTarget}`);
  }
  return { checkpointDir, matchupTarget, seedSetId, outputDir: args.get('outputDir') };
}

if (import.meta.main) {
  const summary = await evaluateCheckpoint(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary.metrics, null, 2)}\n`);
}
