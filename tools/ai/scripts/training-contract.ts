import trainingConfig from '../configs/training-config.json';
import { EnvActionOrder, observationVectorLength, observationVersion } from '@snake/game-core/ml';

type RawTrainingConfig = {
  contractVersion: string;
  generatorVersion: string;
  milestoneGate: {
    validationSeedSetId: string;
    gateSeedSetId: string;
    minimumValidationActionAccuracy: number;
    minimumRandomSafeWinRate: number;
  };
  observationVersion: number;
  observationLength: number;
  actionOrder: string[];
  seedSets: Record<string, number[]>;
};

const rawConfig = trainingConfig as RawTrainingConfig;

function assertFrozenContract(): void {
  if (rawConfig.observationVersion !== observationVersion) {
    throw new Error(`Training config observationVersion drifted: expected ${observationVersion}, received ${rawConfig.observationVersion}`);
  }

  if (rawConfig.observationLength !== observationVectorLength) {
    throw new Error(`Training config observationLength drifted: expected ${observationVectorLength}, received ${rawConfig.observationLength}`);
  }

  if (JSON.stringify(rawConfig.actionOrder) !== JSON.stringify(EnvActionOrder)) {
    throw new Error(`Training config actionOrder drifted: expected ${EnvActionOrder.join(', ')}, received ${rawConfig.actionOrder.join(', ')}`);
  }
}

assertFrozenContract();

export const contractVersion = rawConfig.contractVersion;
export const datasetGeneratorVersion = rawConfig.generatorVersion;
export const milestoneGate = rawConfig.milestoneGate;
export const trainingObservationVersion = rawConfig.observationVersion;
export const trainingObservationLength = rawConfig.observationLength;
export const trainingActionOrder = [...rawConfig.actionOrder] as typeof EnvActionOrder;
export const trainingSeedSets = rawConfig.seedSets;

export type TrainingSeedSetId = keyof typeof trainingSeedSets;

function makeRange(startInclusive: number, endInclusive: number): number[] {
  return Array.from({ length: endInclusive - startInclusive + 1 }, (_, index) => startInclusive + index);
}

export function getSeedSet(seedSetId: string): number[] {
  if (seedSetId === 'train-v1') {
    return makeRange(1_001, 2_000);
  }

  const seeds = trainingSeedSets[seedSetId];
  if (!seeds) {
    throw new Error(`Unknown seed set id: ${seedSetId}`);
  }

  return [...seeds];
}
