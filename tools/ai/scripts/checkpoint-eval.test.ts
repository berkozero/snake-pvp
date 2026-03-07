import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDataset } from './dataset';
import { evaluateCheckpoint } from './checkpoint-eval';

const cleanupPaths: string[] = [];
const AI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function makeTempDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  cleanupPaths.push(dir);
  return dir;
}

function runCommand(args: string[], cwd: string): string {
  const proc = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' });
  if (proc.status !== 0) {
    throw new Error(`Command failed: ${args.join(' ')}\n${proc.stderr}`);
  }
  return proc.stdout ?? '';
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('checkpoint training and evaluation', () => {
  it('can train, reload from model.pt + metadata.json, and evaluate deterministically', async () => {
    const root = await makeTempDir('snake-train');
    const datasetDir = path.join(root, 'dataset-dev');
    const runDir = path.join(root, 'run-dev');
    await generateDataset({
      seedSetId: 'dev-v1',
      outputDir: datasetDir,
      maxEpisodes: 2,
      createdAt: '2026-03-07T00:00:00.000Z',
    });

    runCommand(
      [
        'python3',
        'python/train.py',
        '--dataset',
        datasetDir,
        '--output-dir',
        runDir,
        '--validation-seed-set-id',
        'dev-v1-smoke',
        '--epochs',
        '5',
      ],
      AI_ROOT,
    );

    expect(existsSync(path.join(runDir, 'model.pt'))).toBe(true);
    expect(existsSync(path.join(runDir, 'metadata.json'))).toBe(true);
    expect(existsSync(path.join(runDir, 'metrics.json'))).toBe(true);

    const parkedMetrics = path.join(root, 'metrics-parked.json');
    await rename(path.join(runDir, 'metrics.json'), parkedMetrics);

    const first = await evaluateCheckpoint({
      checkpointDir: runDir,
      matchupTarget: 'random-safe',
      seedSetId: 'dev-v1-smoke',
      outputDir: path.join(root, 'eval-first'),
    });
    const second = await evaluateCheckpoint({
      checkpointDir: runDir,
      matchupTarget: 'random-safe',
      seedSetId: 'dev-v1-smoke',
      outputDir: path.join(root, 'eval-second'),
    });

    expect(first.metrics).toEqual(second.metrics);
    expect(first.flaggedEpisodes.map((episode) => `${episode.seed}:${episode.reason}`)).toEqual(
      second.flaggedEpisodes.map((episode) => `${episode.seed}:${episode.reason}`),
    );
  }, 30_000);

  it('emits replay artifacts for flagged losses or draws', async () => {
    const root = await makeTempDir('snake-flagged');
    const datasetDir = path.join(root, 'dataset-dev');
    const runDir = path.join(root, 'run-zero');
    await generateDataset({
      seedSetId: 'dev-v1',
      outputDir: datasetDir,
      maxEpisodes: 1,
      createdAt: '2026-03-07T00:00:00.000Z',
    });

    runCommand(
      [
        'python3',
        'python/train.py',
        '--dataset',
        datasetDir,
        '--output-dir',
        runDir,
        '--validation-seed-set-id',
        'dev-v1',
        '--epochs',
        '0',
      ],
      AI_ROOT,
    );

    const outputDir = path.join(root, 'eval-heuristic');
    const summary = await evaluateCheckpoint({
      checkpointDir: runDir,
      matchupTarget: 'heuristic',
      seedSetId: 'dev-v1',
      outputDir,
    });

    expect(summary.flaggedEpisodes.length).toBeGreaterThan(0);
    for (const flagged of summary.flaggedEpisodes) {
      const artifactPath = path.join(outputDir, 'flagged', `${flagged.seed}-${flagged.reason}.json`);
      expect(existsSync(artifactPath)).toBe(true);
      const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as { finalOutcome: { winner: string | null } };
      expect(artifact.finalOutcome.winner).not.toBe('p1');
    }
  }, 30_000);
});
