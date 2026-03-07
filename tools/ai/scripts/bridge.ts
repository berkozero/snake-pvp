import { createInterface } from 'node:readline';
import { SnakeMlEnvironment } from '@snake/game-core/ml';
import type { EnvAction, EnvReplayArtifact, EnvResetResult, EnvStepResult } from '@snake/game-core/ml';
import type { PlayerId } from '@snake/game-core';

type BridgeRequest =
  | { id: string; type: 'reset'; seed?: number }
  | { id: string; type: 'step'; actions: Record<PlayerId, EnvAction> }
  | { id: string; type: 'get_observation'; playerId: PlayerId }
  | { id: string; type: 'get_action_mask'; playerId: PlayerId }
  | { id: string; type: 'capture_replay' };

type BridgeResponse =
  | { id: string; type: 'reset_result'; result: EnvResetResult }
  | { id: string; type: 'step_result'; result: EnvStepResult }
  | { id: string; type: 'observation_result'; playerId: PlayerId; observation: number[] }
  | { id: string; type: 'action_mask_result'; playerId: PlayerId; actionMask: boolean[] }
  | { id: string; type: 'replay_result'; replay: EnvReplayArtifact }
  | { id: string; type: 'error'; error: string };

const env = new SnakeMlEnvironment();

function isPlayerId(value: unknown): value is PlayerId {
  return value === 'p1' || value === 'p2';
}

function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const request = value as Record<string, unknown>;
  return typeof request.id === 'string' && typeof request.type === 'string';
}

function respond(response: BridgeResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function handleRequest(request: BridgeRequest): BridgeResponse {
  switch (request.type) {
    case 'reset':
      return { id: request.id, type: 'reset_result', result: env.reset(request.seed) };
    case 'step':
      return { id: request.id, type: 'step_result', result: env.step(request.actions) };
    case 'get_observation':
      if (!isPlayerId(request.playerId)) {
        throw new TypeError('Expected playerId to be p1 or p2');
      }
      return {
        id: request.id,
        type: 'observation_result',
        playerId: request.playerId,
        observation: env.getObservation(request.playerId),
      };
    case 'get_action_mask':
      if (!isPlayerId(request.playerId)) {
        throw new TypeError('Expected playerId to be p1 or p2');
      }
      return {
        id: request.id,
        type: 'action_mask_result',
        playerId: request.playerId,
        actionMask: env.getActionMask(request.playerId),
      };
    case 'capture_replay':
      return { id: request.id, type: 'replay_result', replay: env.captureReplayArtifact() };
  }
}

async function main(): Promise<void> {
  const reader = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  for await (const line of reader) {
    if (!line.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
      if (!isBridgeRequest(parsed)) {
        throw new TypeError('Invalid bridge request envelope');
      }
      respond(handleRequest(parsed));
    } catch (error) {
      const requestId =
        parsed && typeof parsed === 'object' && typeof (parsed as { id?: unknown }).id === 'string'
          ? ((parsed as { id: string }).id)
          : 'unknown';
      respond({
        id: requestId,
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown bridge error',
      });
    }
  }
}

void main();
