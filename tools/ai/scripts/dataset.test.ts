import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDataset } from './dataset';

const cleanupPaths: string[] = [];

async function makeTempDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  cleanupPaths.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('offline dataset generation', () => {
  it('is deterministic for the same seed set and generator version', async () => {
    const root = await makeTempDir('snake-dataset');
    const firstDir = path.join(root, 'dataset-a');
    const secondDir = path.join(root, 'dataset-b');
    const createdAt = '2026-03-07T00:00:00.000Z';

    const first = await generateDataset({
      seedSetId: 'dev-v1',
      outputDir: firstDir,
      maxEpisodes: 2,
      createdAt,
    });
    const second = await generateDataset({
      seedSetId: 'dev-v1',
      outputDir: secondDir,
      maxEpisodes: 2,
      createdAt,
    });

    expect({ ...first.manifest, datasetId: 'same' }).toEqual({ ...second.manifest, datasetId: 'same' });
    expect(await readFile(first.samplesPath, 'utf8')).toEqual(await readFile(second.samplesPath, 'utf8'));
  });

  it('emits samples that match the frozen training contract', async () => {
    const root = await makeTempDir('snake-dataset-contract');
    const datasetDir = path.join(root, 'dataset-contract');
    const result = await generateDataset({
      seedSetId: 'dev-v1',
      outputDir: datasetDir,
      maxEpisodes: 1,
      createdAt: '2026-03-07T00:00:00.000Z',
    });

    const lines = (await readFile(result.samplesPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        observation: number[];
        actionMask: boolean[];
        teacherAction: string;
        observationVersion: number;
      });

    expect(lines.length).toBeGreaterThan(0);
    for (const sample of lines.slice(0, 10)) {
      expect(sample.observation).toHaveLength(44);
      expect(sample.actionMask).toHaveLength(5);
      expect(['up', 'down', 'left', 'right', 'stay']).toContain(sample.teacherAction);
      expect(sample.observationVersion).toBe(2);
    }
  });
});
