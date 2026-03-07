import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDataset } from './dataset';

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

describe('imitation milestone gate', () => {
  it('clears the fixed validation accuracy and dev-v1 random-safe win-rate thresholds', async () => {
    const root = await makeTempDir('snake-milestone');
    const datasetDir = path.join(root, 'dataset-dev-v1');
    const runDir = path.join(root, 'run-milestone');

    await generateDataset({
      seedSetId: 'dev-v1',
      outputDir: datasetDir,
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
        '--epochs',
        '250',
      ],
      AI_ROOT,
    );

    expect(existsSync(path.join(runDir, 'metrics.json'))).toBe(true);
    const metrics = JSON.parse(await readFile(path.join(runDir, 'metrics.json'), 'utf8')) as {
      validationActionAccuracy: number;
      evaluationResultsAgainstRandomSafe: { seedSetId: string; metrics: { winRate: number } };
      milestoneGate: {
        validationSeedSetId: string;
        gateSeedSetId: string;
        minimumValidationActionAccuracy: number;
        minimumRandomSafeWinRate: number;
        passedValidationActionAccuracy: boolean;
        passedRandomSafeWinRate: boolean;
        passed: boolean;
      };
    };

    expect(metrics.milestoneGate.validationSeedSetId).toBe('val-v1');
    expect(metrics.milestoneGate.gateSeedSetId).toBe('dev-v1');
    expect(metrics.evaluationResultsAgainstRandomSafe.seedSetId).toBe('dev-v1');
    expect(metrics.validationActionAccuracy).toBeGreaterThanOrEqual(metrics.milestoneGate.minimumValidationActionAccuracy);
    expect(metrics.evaluationResultsAgainstRandomSafe.metrics.winRate).toBeGreaterThanOrEqual(
      metrics.milestoneGate.minimumRandomSafeWinRate,
    );
    expect(metrics.milestoneGate.passedValidationActionAccuracy).toBe(true);
    expect(metrics.milestoneGate.passedRandomSafeWinRate).toBe(true);
    expect(metrics.milestoneGate.passed).toBe(true);
  }, 90_000);
});
