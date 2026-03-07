import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INIT_CHECKPOINT_METADATA = path.join(
  AI_ROOT,
  '.local',
  'artifacts',
  'checkpoints',
  'run-val-v1-large-h32x32-respawn8',
  'metadata.json',
);

describe('rl python tests', () => {
  it.skipIf(!existsSync(INIT_CHECKPOINT_METADATA))('passes the focused PPO unit tests', () => {
    const proc = spawnSync('python3', ['python/rl_train_test.py'], {
      cwd: AI_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });

    expect(proc.status, proc.stderr).toBe(0);
  }, 30_000);
});
