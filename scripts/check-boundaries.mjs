import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();

const boundaryRules = [
  {
    label: 'apps/web',
    root: path.join(repoRoot, 'apps/web/src'),
    forbidden: [path.join(repoRoot, 'apps/server'), path.join(repoRoot, 'tools/ai')],
  },
  {
    label: 'apps/server',
    root: path.join(repoRoot, 'apps/server/src'),
    forbidden: [path.join(repoRoot, 'tools/ai')],
  },
];

const importPattern = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function collectFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(fullPath);
      }
      if (/\.(ts|tsx)$/.test(entry.name)) {
        return [fullPath];
      }
      return [];
    }),
  );
  return files.flat();
}

async function resolveImport(filePath, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const basePath = path.resolve(path.dirname(filePath), specifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.json`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
  ];

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        return candidate;
      }
    } catch {
      // Keep trying.
    }
  }

  return basePath;
}

async function checkRule(rule) {
  const files = await collectFiles(rule.root);
  const violations = [];

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) {
        continue;
      }

      if (!specifier.startsWith('.')) {
        if (specifier.startsWith('apps/server') || specifier.startsWith('tools/ai')) {
          violations.push(`${path.relative(repoRoot, filePath)} imports forbidden specifier ${specifier}`);
        }
        continue;
      }

      const resolved = await resolveImport(filePath, specifier);
      if (!resolved) {
        continue;
      }

      for (const forbiddenRoot of rule.forbidden) {
        if (resolved.startsWith(forbiddenRoot)) {
          violations.push(
            `${path.relative(repoRoot, filePath)} crosses into ${path.relative(repoRoot, forbiddenRoot)} via ${specifier}`,
          );
        }
      }
    }
  }

  return violations;
}

const failures = (await Promise.all(boundaryRules.map(checkRule))).flat();

if (failures.length > 0) {
  console.error('Boundary check failed.');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Boundary check passed.');
