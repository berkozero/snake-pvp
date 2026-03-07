import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateCheckpoint } from './checkpoint-eval';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('rl smoke flow', () => {
  it('completes the smoke command, emits artifacts, and evaluates via the unchanged ts path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'snake-rl-smoke-'));
    cleanupPaths.push(root);
    const proc = spawnSync('bun', ['run', 'ai:rl-selfplay-smoke'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(proc.status, proc.stderr).toBe(0);
    const smokeResult = JSON.parse(proc.stdout) as { outputDir: string };
    const runDir = smokeResult.outputDir;
    cleanupPaths.push(runDir);
    expect(existsSync(path.join(runDir, 'config.json'))).toBe(true);
    expect(existsSync(path.join(runDir, 'trainer_checkpoint.pt'))).toBe(true);
    expect(existsSync(path.join(runDir, 'policy', 'model.pt'))).toBe(true);
    expect(existsSync(path.join(runDir, 'policy', 'metadata.json'))).toBe(true);
    expect(existsSync(path.join(runDir, 'metrics.jsonl'))).toBe(true);
    expect(existsSync(path.join(runDir, 'evals', '1'))).toBe(true);
    expect(existsSync(path.join(runDir, 'replays', '1', 'flagged'))).toBe(true);

    const latest = JSON.parse(await readFile(path.join(runDir, 'latest.json'), 'utf8')) as { latestUpdate: number };
    expect(latest.latestUpdate).toBeGreaterThan(0);

    const summary = await evaluateCheckpoint({
      checkpointDir: runDir,
      matchupTarget: 'random-safe',
      seedSetId: 'dev-v1-smoke',
      outputDir: path.join(root, 'eval-rerun'),
    });
    expect(summary.metrics.episodes).toBe(2);
  }, 120_000);
});
