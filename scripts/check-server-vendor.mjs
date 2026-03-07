import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const sourceRoot = path.join(repoRoot, 'packages', 'game-core', 'src');
const vendorRoot = path.join(repoRoot, 'apps', 'server', 'vendor', 'game-core', 'src');

const files = [
  'index.ts',
  'constants.ts',
  'types.ts',
  'engine.ts',
  'protocol.ts',
  path.join('core', 'index.ts'),
  path.join('core', 'bot.ts'),
  path.join('core', 'simulator.ts'),
  path.join('ml', 'index.ts'),
];

for (const relativePath of files) {
  const [source, vendor] = await Promise.all([
    readFile(path.join(sourceRoot, relativePath), 'utf8'),
    readFile(path.join(vendorRoot, relativePath), 'utf8'),
  ]);

  if (source !== vendor) {
    throw new Error(`Vendored game-core drifted: ${relativePath}`);
  }
}

console.log('Server vendor check passed.');
