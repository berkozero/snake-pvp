import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type BridgeResponse = {
  id: string;
  type: string;
  error?: string;
  [key: string]: unknown;
};

const AI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class BridgeClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lines: string[] = [];
  private readonly pending = new Map<string, (response: BridgeResponse) => void>();
  private nextId = 0;

  constructor() {
    this.process = spawn('bun', ['scripts/bridge.ts'], {
      cwd: AI_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout.setEncoding('utf8');
    let buffer = '';
    this.process.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          const response = JSON.parse(line) as BridgeResponse;
          this.pending.get(response.id)?.(response);
          this.pending.delete(response.id);
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
  }

  async request(payload: Record<string, unknown>): Promise<BridgeResponse> {
    const id = `req-${this.nextId++}`;
    const result = new Promise<BridgeResponse>((resolve) => {
      this.pending.set(id, resolve);
    });

    this.process.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    return result;
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    await once(this.process, 'exit');
  }
}

describe('ai bridge', () => {
  let client: BridgeClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
  });

  it('can reset, step, query masks, and capture replay over stdin/stdout', async () => {
    client = new BridgeClient();

    const reset = await client.request({ type: 'reset', seed: 42 });
    expect(reset.type).toBe('reset_result');
    expect((reset.result as { observationVersion: number }).observationVersion).toBe(2);

    const mask = await client.request({ type: 'get_action_mask', playerId: 'p1' });
    expect(mask.type).toBe('action_mask_result');
    expect(mask.actionMask).toEqual([true, true, false, true, true]);

    const step = await client.request({ type: 'step', actions: { p1: 'up', p2: 'stay' } });
    expect(step.type).toBe('step_result');
    expect((step.result as { done: boolean }).done).toBe(false);

    const observation = await client.request({ type: 'get_observation', playerId: 'p1' });
    expect(observation.type).toBe('observation_result');
    expect((observation.observation as number[]).length).toBe(44);

    const replay = await client.request({ type: 'capture_replay' });
    expect(replay.type).toBe('replay_result');
    expect((replay.replay as { decisionSteps: unknown[] }).decisionSteps).toHaveLength(1);
  });

  it('returns structured errors for invalid requests', async () => {
    client = new BridgeClient();
    await client.request({ type: 'reset', seed: 1 });
    const response = await client.request({ type: 'step', actions: { p1: 'stay' } });

    expect(response.type).toBe('error');
    expect(response.error).toMatch(/actions/i);
  });
});
