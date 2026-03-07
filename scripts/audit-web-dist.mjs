import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const distRoot = path.join(process.cwd(), 'apps/web/dist');
const forbiddenMarkers = ['ppo-', 'tools/ai', 'apps/server', 'checkpoint', 'trainer_checkpoint', 'python/'];

async function collectFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(fullPath);
      }
      return [fullPath];
    }),
  );
  return files.flat();
}

const files = await collectFiles(distRoot);
const violations = [];

for (const filePath of files) {
  const relativePath = path.relative(distRoot, filePath);
  for (const marker of forbiddenMarkers) {
    if (relativePath.includes(marker)) {
      violations.push(`forbidden filename marker ${marker} in ${relativePath}`);
    }
  }

  if (!/\.(html|js|css|json|txt)$/.test(filePath)) {
    continue;
  }

  const contents = await readFile(filePath, 'utf8');
  for (const marker of forbiddenMarkers) {
    if (contents.includes(marker)) {
      violations.push(`forbidden content marker ${marker} in ${relativePath}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Web dist audit failed.');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('Web dist audit passed.');
