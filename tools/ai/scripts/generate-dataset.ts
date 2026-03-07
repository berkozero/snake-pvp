import path from 'node:path';
import { generateDataset } from './dataset';

type Args = {
  seedSetId: string;
  outputDir: string;
  maxEpisodes?: number;
};

function parseArgs(argv: string[]): Args {
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

  const seedSetId = args.get('seedSetId');
  const outputDir = args.get('outputDir');
  if (!seedSetId || !outputDir) {
    throw new Error('Usage: bun tools/ai/scripts/generate-dataset.ts --seedSetId <id> --outputDir <dir> [--maxEpisodes <count>]');
  }

  const maxEpisodes = args.has('maxEpisodes') ? Number.parseInt(args.get('maxEpisodes')!, 10) : undefined;
  if (maxEpisodes !== undefined && (!Number.isInteger(maxEpisodes) || maxEpisodes <= 0)) {
    throw new Error(`Expected maxEpisodes to be a positive integer, received ${args.get('maxEpisodes')}`);
  }

  return {
    seedSetId,
    outputDir: path.resolve(outputDir),
    maxEpisodes,
  };
}

const args = parseArgs(process.argv.slice(2));
const result = await generateDataset(args);
process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
