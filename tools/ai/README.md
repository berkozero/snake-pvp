# Training Notes

This directory is reserved for local-only training code.

Current constraints:

- TypeScript remains authoritative for game rules, stepping, replay, and evaluation
- no production app or server entrypoint may import from `tools/ai/`
- any eventual learned policy must be exportable to a tiny pure-TypeScript runtime suitable for Railway
- production Python, heavy inference runtimes, and sidecar model services are out of scope

Workspace layout:

- `scripts/`: Bun/TypeScript entrypoints, harnesses, and tests
- `configs/`: training and RL config JSON plus ablation configs
- `python/`: trainer, export, and runtime bridge code
- `.local/`: ignored local outputs such as datasets, checkpoints, evals, replays, and RL runs

Implemented pieces:

- deterministic offline evaluation lives in `packages/game-core/src/ml/eval.ts`
- the first trainer bridge now exists in `scripts/bridge.ts`
- the bridge uses newline-delimited JSON over stdin/stdout
- supported requests are `reset`, `step`, `get_observation`, `get_action_mask`, and `capture_replay`
- `scripts/smoke-eval.ts` runs a seeded local smoke evaluation pass
- `scripts/generate-dataset.ts` writes heuristic-labeled offline datasets to `tools/ai/.local/artifacts/datasets/<datasetId>/`
- `python/train.py` trains the fixed `44 -> 16 -> 5` masked MLP checkpoint format
- `scripts/checkpoint-eval.ts` evaluates Python checkpoints with TypeScript still authoritative for environment stepping and replay capture
- `scripts/milestone-gate.test.ts` enforces the first imitation milestone against the fixed seed sets

Intended usage:

- v1 imitation training is offline-first: TypeScript generates datasets to disk, Python trains checkpoints from those artifacts, and TypeScript remains authoritative for evaluation
- the stdin/stdout trainer bridge remains available for future online training or self-play work, but it is not the default path in this milestone
- no production code path should import from `tools/ai/`
- exported policies still need to target tiny pure-TypeScript Railway inference

Frozen imitation-v1 contract:

- observation version stays at `2`
- observation length stays at `44`
- action order stays at `['up', 'down', 'left', 'right', 'stay']`
- fixed seed sets live in `configs/training-config.json`
- milestone gate is fixed to `validation accuracy >= 0.90` on `val-v1` and `win rate >= 0.65` vs `random-safe` on `dev-v1`

Python setup:

- install Python deps with `python3 -m pip install -r tools/ai/python/requirements.txt`
- pinned training dependencies currently are `numpy==2.0.2` and `torch==2.8.0`

Training commands:

- `bun run ai:dataset -- --seedSetId dev-v1 --outputDir tools/ai/.local/artifacts/datasets/dev-v1`
- `bun run ai:train -- --dataset tools/ai/.local/artifacts/datasets/dev-v1 --output-dir tools/ai/.local/artifacts/checkpoints/run-dev-v1`
- `bun run ai:eval -- --checkpointDir tools/ai/.local/artifacts/checkpoints/run-dev-v1 --matchupTarget random-safe --seedSetId dev-v1`
- `bun run ai:gate`

RL Phase 1 baseline:

- the default Phase 1 `train` preset now matches the current best ablation-a learning rate (`0.0001`)
- the promoted RL baseline run is `tools/ai/.local/artifacts/rl-runs/ppo-ablation-a`
- authoritative best-checkpoint selection is tracked per run in `tools/ai/.local/artifacts/rl-runs/<runId>/best-checkpoint.json`
- the selected best exported policy is copied to `tools/ai/.local/artifacts/rl-runs/<runId>/best-policy/`
- optional escalation hooks now exist in `python/rl_train.py` for opponent-pool self-play and hard-state auxiliary reuse
- those hooks are off by default in `configs/rl-config.json`
- an opt-in escalation example is pinned in `configs/ablations/rl-ppo-escalation-v1.json`
