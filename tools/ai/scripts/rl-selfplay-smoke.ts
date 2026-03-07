import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type SmokeConfig = {
  presets: {
    smoke: {
      overallTimeoutSec: number;
    };
  };
};

const SCRIPTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const AI_ROOT = path.resolve(SCRIPTS_ROOT, '..');
const configPath = path.join(AI_ROOT, 'configs', 'rl-config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as SmokeConfig;
const timeoutMs = config.presets.smoke.overallTimeoutSec * 1000;
const runId = `ppo-smoke-${Date.now()}`;
const outputDir = path.join(AI_ROOT, '.local', 'artifacts', 'rl-runs', runId);

const proc = spawnSync(
  'python3',
  ['python/rl_train.py', '--config', configPath, '--preset', 'smoke', '--run-id', runId, '--output-dir', outputDir],
  {
    cwd: AI_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  },
);

if (proc.status !== 0) {
  throw new Error(`Smoke self-play failed\n${proc.stderr}`);
}

const requiredPaths = [
  path.join(outputDir, 'config.json'),
  path.join(outputDir, 'trainer_checkpoint.pt'),
  path.join(outputDir, 'policy', 'model.pt'),
  path.join(outputDir, 'policy', 'metadata.json'),
  path.join(outputDir, 'metrics.jsonl'),
  path.join(outputDir, 'latest.json'),
];

for (const requiredPath of requiredPaths) {
  if (!existsSync(requiredPath)) {
    throw new Error(`Missing smoke artifact: ${requiredPath}`);
  }
}

process.stdout.write(`${JSON.stringify({ runId, outputDir }, null, 2)}\n`);
