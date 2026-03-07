import { evaluateCheckpoint, resolveCheckpointDir } from './checkpoint-eval';

function parseArgs(argv: string[]): {
  checkpointDir: string;
  matchupTarget: 'random-safe' | 'heuristic';
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
    throw new Error('Usage: bun tools/ai/scripts/rl-eval.ts --checkpointDir <dir> --matchupTarget <random-safe|heuristic> --seedSetId <id> [--outputDir <dir>]');
  }
  if (matchupTarget !== 'random-safe' && matchupTarget !== 'heuristic') {
    throw new Error(`Unsupported matchupTarget: ${matchupTarget}`);
  }
  return { checkpointDir, matchupTarget, seedSetId, outputDir: args.get('outputDir') };
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const summary = await evaluateCheckpoint({
    ...options,
    checkpointDir: await resolveCheckpointDir(options.checkpointDir),
  });
  process.stdout.write(`${JSON.stringify(summary.metrics, null, 2)}\n`);
}
