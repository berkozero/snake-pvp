import { describe, expect, it } from 'vitest';
import { COUNTDOWN_MS, SnakeSimulator, createSeededRandomFactory } from '@snake/game-core';
import { loadRlPolicy } from './rlPolicy';

describe('loadRlPolicy', () => {
  it('matches the promoted PPO checkpoint on fixed seeded states', async () => {
    const policy = await loadRlPolicy();
    const simulator = new SnakeSimulator({ randomFactory: createSeededRandomFactory(101) });
    simulator.startCountdown();
    simulator.advanceElapsed(COUNTDOWN_MS);

    expect(policy.metadata.runId).toBe('ppo-ablation-a');
    expect(policy.selectAction(simulator.getState(), 'p1')).toBe('up');
    expect(policy.selectAction(simulator.getState(), 'p2')).toBe('up');

    simulator.submitAction('p1', 'up');
    simulator.submitAction('p2', 'left');
    simulator.advanceElapsed(simulator.getState().movementMs);

    expect(policy.selectAction(simulator.getState(), 'p1')).toBe('up');
    expect(policy.selectAction(simulator.getState(), 'p2')).toBe('up');
  });

  it('always returns a legal action from the frozen action order', async () => {
    const policy = await loadRlPolicy();
    const simulator = new SnakeSimulator({ randomFactory: createSeededRandomFactory(7) });
    simulator.startCountdown();
    simulator.advanceElapsed(COUNTDOWN_MS);

    for (let step = 0; step < 10; step += 1) {
      const p1Action = policy.selectAction(simulator.getState(), 'p1');
      const p2Action = policy.selectAction(simulator.getState(), 'p2');
      expect(['up', 'down', 'left', 'right', 'stay']).toContain(p1Action);
      expect(['up', 'down', 'left', 'right', 'stay']).toContain(p2Action);
      if (p1Action !== 'stay') {
        simulator.submitAction('p1', p1Action);
      }
      if (p2Action !== 'stay') {
        simulator.submitAction('p2', p2Action);
      }
      simulator.advanceElapsed(simulator.getState().movementMs);
    }
  });
});
