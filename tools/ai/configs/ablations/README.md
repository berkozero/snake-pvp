# RL PPO Ablation Plan

These three configs are ordered from lowest-risk drift reduction to the full first-pass stability adjustment.

## Run Order

1. `ablation-a`
   - Change only `learningRate`: `0.0003 -> 0.0001`
   - Goal: reduce update aggressiveness while holding exploration and sample reuse fixed.
2. `ablation-b`
   - Change `learningRate`: `0.0003 -> 0.0001`
   - Change `entropyCoef`: `0.01 -> 0.003`
   - Goal: keep the lower step size and reduce policy diffusion away from the imitation prior.
3. `ablation-c`
   - Change `learningRate`: `0.0003 -> 0.0001`
   - Change `entropyCoef`: `0.01 -> 0.003`
   - Change `ppoEpochs`: `4 -> 3`
   - Goal: reduce both exploration pressure and per-rollout over-optimization.

## Commands

```bash
python3 tools/ai/python/rl_train.py --config tools/ai/configs/ablations/rl-ppo-ablation-a.json --preset train --run-id ppo-ablation-a
bun run ai:rl-eval -- --checkpointDir tools/ai/.local/artifacts/rl-runs/ppo-ablation-a --matchupTarget random-safe --seedSetId dev-v1
bun run ai:rl-eval -- --checkpointDir tools/ai/.local/artifacts/rl-runs/ppo-ablation-a --matchupTarget heuristic --seedSetId val-v1
```

```bash
python3 tools/ai/python/rl_train.py --config tools/ai/configs/ablations/rl-ppo-ablation-b.json --preset train --run-id ppo-ablation-b
bun run ai:rl-eval -- --checkpointDir tools/ai/.local/artifacts/rl-runs/ppo-ablation-b --matchupTarget random-safe --seedSetId dev-v1
bun run ai:rl-eval -- --checkpointDir tools/ai/.local/artifacts/rl-runs/ppo-ablation-b --matchupTarget heuristic --seedSetId val-v1
```

```bash
python3 tools/ai/python/rl_train.py --config tools/ai/configs/ablations/rl-ppo-ablation-c.json --preset train --run-id ppo-ablation-c
bun run ai:rl-eval -- --checkpointDir tools/ai/.local/artifacts/rl-runs/ppo-ablation-c --matchupTarget random-safe --seedSetId dev-v1
bun run ai:rl-eval -- --checkpointDir tools/ai/.local/artifacts/rl-runs/ppo-ablation-c --matchupTarget heuristic --seedSetId val-v1
```

## Decision Rule

- Keep only runs with no regression vs `random-safe`.
- Prefer the earliest config in the list that reaches `>= 0.578125` vs heuristic on `val-v1`.
- If none reach target, inspect flagged heuristic replays for the best of the three before changing rewards.
