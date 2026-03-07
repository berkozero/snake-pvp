import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('rl python tests', () => {
  it('passes the focused PPO unit tests', () => {
    const proc = spawnSync('python3', ['python/rl_train_test.py'], {
      cwd: AI_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });

    expect(proc.status, proc.stderr).toBe(0);
  }, 30_000);
});
