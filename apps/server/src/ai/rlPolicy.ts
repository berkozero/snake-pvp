import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createObservationVector,
  createSimulatorSnapshot,
  EnvActionOrder,
  getLegalActionMask,
  observationVectorLength,
  observationVersion,
  type EnvAction,
  type PlayerId,
  type RoundState,
} from '@snake/game-core';

type Activation = 'relu' | 'identity';

type PolicyLayer = {
  weight: number[][];
  bias: number[];
  activation: Activation;
};

type PolicyMetadata = {
  runId: string;
  modelType: string;
  inputSize: number;
  hiddenSize: number;
  hiddenSizes?: number[];
  outputSize: number;
  actionOrder: string[];
  observationVersion: number;
  exportVersion?: string;
};

type RlPolicyJson = {
  schemaVersion: string;
  metadata: PolicyMetadata;
  inputMean: number[];
  inputStd: number[];
  layers: PolicyLayer[];
};

export type LoadedRlPolicy = {
  metadata: PolicyMetadata;
  selectAction(state: RoundState, playerId: PlayerId): EnvAction;
};

const DEFAULT_POLICY_PATH = new URL('./policies/ppo-ablation-a.best-policy.json', import.meta.url);
const EXPECTED_HIDDEN_SIZES = [32, 32];
const EXPECTED_SCHEMA_VERSION = 'rl-policy-v1';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isFiniteVector(values: unknown, expectedLength: number, label: string): number[] {
  assert(Array.isArray(values), `Expected ${label} to be an array`);
  assert(values.length === expectedLength, `Expected ${label} length ${expectedLength}, received ${values.length}`);
  return values.map((value, index) => {
    assert(typeof value === 'number' && Number.isFinite(value), `Expected finite ${label}[${index}]`);
    return value;
  });
}

function validateLayer(layer: PolicyLayer, inputWidth: number, outputWidth: number, index: number): void {
  assert(Array.isArray(layer.weight), `Expected layer ${index} weight matrix`);
  assert(layer.weight.length === outputWidth, `Expected layer ${index} weight rows ${outputWidth}, received ${layer.weight.length}`);
  layer.weight.forEach((row, rowIndex) => {
    assert(Array.isArray(row), `Expected layer ${index} weight row ${rowIndex}`);
    assert(row.length === inputWidth, `Expected layer ${index} weight cols ${inputWidth}, received ${row.length}`);
    row.forEach((value, colIndex) => {
      assert(typeof value === 'number' && Number.isFinite(value), `Expected finite layer ${index} weight[${rowIndex}][${colIndex}]`);
    });
  });
  isFiniteVector(layer.bias, outputWidth, `layer ${index} bias`);
  assert(layer.activation === 'relu' || layer.activation === 'identity', `Unsupported layer ${index} activation`);
}

function validatePolicyJson(policy: RlPolicyJson): void {
  assert(policy.schemaVersion === EXPECTED_SCHEMA_VERSION, `Expected schemaVersion ${EXPECTED_SCHEMA_VERSION}, received ${policy.schemaVersion}`);
  assert(policy.metadata.observationVersion === observationVersion, `Policy observationVersion drifted: ${policy.metadata.observationVersion}`);
  assert(policy.metadata.inputSize === observationVectorLength, `Policy inputSize drifted: ${policy.metadata.inputSize}`);
  assert(policy.metadata.outputSize === EnvActionOrder.length, `Policy outputSize drifted: ${policy.metadata.outputSize}`);
  assert(JSON.stringify(policy.metadata.actionOrder) === JSON.stringify(EnvActionOrder), 'Policy action order drifted from the frozen contract');
  const hiddenSizes = policy.metadata.hiddenSizes ?? [policy.metadata.hiddenSize];
  assert(JSON.stringify(hiddenSizes) === JSON.stringify(EXPECTED_HIDDEN_SIZES), `Policy hidden sizes drifted: ${hiddenSizes.join(',')}`);
  isFiniteVector(policy.inputMean, observationVectorLength, 'inputMean');
  isFiniteVector(policy.inputStd, observationVectorLength, 'inputStd');
  assert(policy.layers.length === 3, `Expected 3 layers, received ${policy.layers.length}`);
  validateLayer(policy.layers[0], observationVectorLength, EXPECTED_HIDDEN_SIZES[0], 0);
  validateLayer(policy.layers[1], EXPECTED_HIDDEN_SIZES[0], EXPECTED_HIDDEN_SIZES[1], 1);
  validateLayer(policy.layers[2], EXPECTED_HIDDEN_SIZES[1], EnvActionOrder.length, 2);
}

function applyLayer(input: number[], layer: PolicyLayer): number[] {
  const output = new Array<number>(layer.bias.length);
  for (let rowIndex = 0; rowIndex < layer.weight.length; rowIndex += 1) {
    let sum = layer.bias[rowIndex];
    const row = layer.weight[rowIndex];
    for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
      sum += row[colIndex] * input[colIndex];
    }
    output[rowIndex] = layer.activation === 'relu' ? Math.max(0, sum) : sum;
  }
  return output;
}

function maskedArgmax(logits: number[], mask: boolean[]): number {
  let bestIndex = -1;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < logits.length; index += 1) {
    if (!mask[index]) {
      continue;
    }
    if (bestIndex === -1 || logits[index] > bestValue) {
      bestIndex = index;
      bestValue = logits[index];
    }
  }

  if (bestIndex === -1) {
    throw new Error('Received an action mask with no legal actions');
  }

  return bestIndex;
}

function normalizeObservation(observation: number[], mean: number[], std: number[]): number[] {
  return observation.map((value, index) => (value - mean[index]) / std[index]);
}

export async function loadRlPolicy(policyPath: string | URL = DEFAULT_POLICY_PATH): Promise<LoadedRlPolicy> {
  const resolvedPath = policyPath instanceof URL ? policyPath : path.resolve(policyPath);
  const raw = await readFile(resolvedPath, 'utf8');
  const policy = JSON.parse(raw) as RlPolicyJson;
  validatePolicyJson(policy);

  return {
    metadata: policy.metadata,
    selectAction(state, playerId) {
      const snapshot = createSimulatorSnapshot(state);
      const observation = createObservationVector(snapshot, playerId);
      const actionMask = getLegalActionMask(snapshot, playerId);
      const normalized = normalizeObservation(observation, policy.inputMean, policy.inputStd);
      const hiddenA = applyLayer(normalized, policy.layers[0]);
      const hiddenB = applyLayer(hiddenA, policy.layers[1]);
      const logits = applyLayer(hiddenB, policy.layers[2]);
      return EnvActionOrder[maskedArgmax(logits, actionMask)];
    },
  };
}

export function getDefaultRlPolicyPath(): string {
  return fileURLToPath(DEFAULT_POLICY_PATH);
}
