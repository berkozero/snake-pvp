from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import torch
import torch.nn.functional as F

from common import INDEX_TO_ACTION, create_model, set_deterministic_seed
from rl_bridge import BridgeClient
from rl_core import ActorCriticModel, export_policy_checkpoint, initialize_actor_critic_from_policy, load_policy_checkpoint, masked_logits, masked_sample, normalize_observations


ROOT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = ROOT_DIR.parent.parent
RUNS_DIR = ROOT_DIR / ".local" / "artifacts" / "rl-runs"
PLAYER_IDS = ["p1", "p2"]


@dataclass(frozen=True)
class ResolvedConfig:
    preset_name: str
    values: Dict[str, Any]
    source_path: Path
    init_checkpoint_dir: Path


@dataclass(frozen=True)
class RuntimeCheckpointState:
    init_metadata: Dict[str, Any]
    input_mean: np.ndarray
    input_std: np.ndarray
    current_seed: int
    next_observations: Dict[str, np.ndarray]
    next_masks: Dict[str, np.ndarray]
    pending_replay: Dict[str, Any]
    episode_return_accumulator: Dict[str, float]
    torch_rng_state: torch.Tensor
    torch_generator_state: torch.Tensor
    numpy_rng_state: Dict[str, Any]
    active_opponent_id: str


@dataclass(frozen=True)
class PolicyBundle:
    name: str
    model: torch.nn.Module
    input_mean: np.ndarray
    input_std: np.ndarray


@dataclass(frozen=True)
class HardStateBatch:
    observations: np.ndarray
    action_masks: np.ndarray
    actions: np.ndarray
    source_dir: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--init-checkpoint")
    parser.add_argument("--preset", default="smoke")
    parser.add_argument("--output-dir")
    parser.add_argument("--run-id")
    parser.add_argument("--resume-from")
    return parser.parse_args()


def load_config(config_path: Path, preset_name: str, init_override: str | None) -> ResolvedConfig:
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    preset = raw["presets"].get(preset_name)
    if preset is None:
        raise ValueError(f"Unknown preset: {preset_name}")
    init_checkpoint = Path(init_override or raw["defaultInitCheckpointDir"])
    if not init_checkpoint.is_absolute():
        init_checkpoint = (REPO_DIR / init_checkpoint).resolve()
    return ResolvedConfig(
        preset_name=preset_name,
        values=preset,
        source_path=config_path.resolve(),
        init_checkpoint_dir=init_checkpoint,
    )


def make_run_id(preset_name: str) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"ppo-{preset_name}-{stamp}"


def compute_explained_variance(targets: np.ndarray, predictions: np.ndarray) -> float:
    variance = float(np.var(targets))
    if variance == 0:
        return 0.0
    return 1.0 - float(np.var(targets - predictions) / variance)


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def append_jsonl(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + "\n")


def load_policy_bundle(checkpoint_dir: Path, name: str) -> PolicyBundle:
    checkpoint = load_policy_checkpoint(checkpoint_dir)
    metadata = checkpoint.metadata
    hidden_sizes = metadata.get("hiddenSizes", [metadata["hiddenSize"]])
    model = create_model(
        input_size=metadata["inputSize"],
        hidden_sizes=hidden_sizes,
        output_size=metadata["outputSize"],
    )
    model.load_state_dict(checkpoint.payload["state_dict"])
    model.eval()
    return PolicyBundle(
        name=name,
        model=model,
        input_mean=checkpoint.input_mean,
        input_std=checkpoint.input_std,
    )


def copy_policy_checkpoint(source_dir: Path, destination_dir: Path) -> None:
    if destination_dir.exists():
        shutil.rmtree(destination_dir)
    shutil.copytree(source_dir, destination_dir)


def maybe_update_best_checkpoint(
    run_dir: Path,
    run_id: str,
    update_index: int,
    policy_dir: Path,
    heuristic_eval: Dict[str, Any],
    random_safe_eval: Dict[str, Any],
) -> Dict[str, Any] | None:
    best_manifest_path = run_dir / "best-checkpoint.json"
    current_heuristic_win_rate = float(heuristic_eval["metrics"]["winRate"])
    previous_best_win_rate = float("-inf")
    previous_best_update = None
    if best_manifest_path.exists():
        previous_best = json.loads(best_manifest_path.read_text(encoding="utf-8"))
        previous_best_win_rate = float(previous_best["heuristicWinRate"])
        previous_best_update = int(previous_best["updateIndex"])

    if current_heuristic_win_rate <= previous_best_win_rate:
        return None

    best_policy_dir = run_dir / "best-policy"
    copy_policy_checkpoint(policy_dir, best_policy_dir)
    manifest = {
        "runId": run_id,
        "selectionMetric": "heuristic-val-v1-win-rate",
        "seedSetId": heuristic_eval["seedSetId"],
        "matchupTarget": heuristic_eval["matchupTarget"],
        "updateIndex": update_index,
        "policyDir": str(best_policy_dir),
        "heuristicWinRate": current_heuristic_win_rate,
        "randomSafeWinRate": float(random_safe_eval["metrics"]["winRate"]),
        "previousBestUpdateIndex": previous_best_update,
        "selectedAt": datetime.now(timezone.utc).isoformat(),
    }
    write_json(best_manifest_path, manifest)
    return manifest


class OpponentPoolManager:
    def __init__(self, config: Dict[str, Any], init_checkpoint_dir: Path, run_dir: Path) -> None:
        self._config = config.get("opponentPool", {})
        self._run_dir = run_dir
        self._frozen_init_bundle = load_policy_bundle(init_checkpoint_dir, "frozen-init")
        self._active_opponent_id = "self-current"

    @property
    def enabled(self) -> bool:
        return bool(self._config.get("enabled", False))

    @property
    def active_opponent_id(self) -> str:
        return self._active_opponent_id

    def restore(self, opponent_id: str) -> None:
        self._active_opponent_id = opponent_id

    def select_for_episode(self) -> str:
        if not self.enabled:
            self._active_opponent_id = "self-current"
            return self._active_opponent_id

        candidate_ids: List[str] = []
        weights: List[float] = []

        def add_candidate(candidate_id: str, weight: float, metadata_path: Path | None = None) -> None:
            if weight <= 0:
                return
            if metadata_path is not None and not metadata_path.exists():
                return
            candidate_ids.append(candidate_id)
            weights.append(weight)

        add_candidate("self-current", float(self._config.get("selfPlayWeight", 1.0)))
        add_candidate("frozen-init", float(self._config.get("frozenInitWeight", 0.0)))
        add_candidate("best-policy", float(self._config.get("bestPolicyWeight", 0.0)), self._run_dir / "best-policy" / "metadata.json")

        if not candidate_ids:
            self._active_opponent_id = "self-current"
            return self._active_opponent_id

        probabilities = np.asarray(weights, dtype=np.float64)
        probabilities = probabilities / probabilities.sum()
        self._active_opponent_id = str(np.random.choice(candidate_ids, p=probabilities))
        return self._active_opponent_id

    def select_action(
        self,
        actor_critic: ActorCriticModel,
        observation: np.ndarray,
        action_mask: np.ndarray,
        generator: torch.Generator,
        current_input_mean: np.ndarray,
        current_input_std: np.ndarray,
    ) -> str:
        if self._active_opponent_id == "self-current":
            normalized = normalize_observations(observation[np.newaxis, :], current_input_mean, current_input_std)
            with torch.no_grad():
                logits, _value = actor_critic(torch.from_numpy(normalized))
                actions, _log_probs, _entropy = masked_sample(
                    logits,
                    torch.from_numpy(action_mask[np.newaxis, :].astype(np.bool_)),
                    generator=generator,
                )
            return INDEX_TO_ACTION[int(actions.item())]

        bundle = self._frozen_init_bundle
        if self._active_opponent_id == "best-policy":
            bundle = load_policy_bundle(self._run_dir / "best-policy", "best-policy")

        normalized = normalize_observations(observation[np.newaxis, :], bundle.input_mean, bundle.input_std)
        with torch.no_grad():
            logits = bundle.model(torch.from_numpy(normalized))
            actions, _log_probs, _entropy = masked_sample(
                logits,
                torch.from_numpy(action_mask[np.newaxis, :].astype(np.bool_)),
                generator=generator,
            )
        return INDEX_TO_ACTION[int(actions.item())]


def load_hard_state_batch(dataset_dir: Path, max_samples: int) -> HardStateBatch | None:
    samples_path = dataset_dir / "samples.jsonl"
    if not samples_path.exists():
        return None

    observations: List[List[float]] = []
    action_masks: List[List[bool]] = []
    actions: List[int] = []
    action_order = ["up", "down", "left", "right", "stay"]

    with samples_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            sample = json.loads(line)
            observations.append(sample["observation"])
            action_masks.append(sample["actionMask"])
            actions.append(action_order.index(sample["teacherAction"]))

    if not observations:
        return None

    if len(observations) > max_samples:
        indices = np.random.choice(len(observations), size=max_samples, replace=False)
        observations = [observations[index] for index in indices]
        action_masks = [action_masks[index] for index in indices]
        actions = [actions[index] for index in indices]

    return HardStateBatch(
        observations=np.asarray(observations, dtype=np.float32),
        action_masks=np.asarray(action_masks, dtype=np.bool_),
        actions=np.asarray(actions, dtype=np.int64),
        source_dir=str(dataset_dir),
    )


def maybe_refresh_hard_state_batch(run_dir: Path, update_index: int, heuristic_eval_dir: Path, config: Dict[str, Any]) -> HardStateBatch | None:
    hard_state_config = config.get("hardStateReuse", {})
    if not hard_state_config.get("enabled", False):
        return None

    refresh_every_updates = int(hard_state_config.get("refreshEveryUpdates", 5))
    if refresh_every_updates <= 0 or update_index % refresh_every_updates != 0:
        return None

    flagged_dir = heuristic_eval_dir / "flagged"
    if not flagged_dir.exists():
        return None

    output_root = run_dir / "hard-states" / str(update_index)
    subprocess.run(
        [
            "bun",
            "tools/ai/scripts/extract-hard-states.ts",
            "--flaggedDir",
            str(flagged_dir),
            "--outputDir",
            str(output_root),
        ],
        cwd=REPO_DIR,
        check=True,
    )
    bucket_id = str(hard_state_config.get("bucketId", "safety-critical"))
    return load_hard_state_batch(output_root / bucket_id, int(hard_state_config.get("maxSamples", 2048)))


def evaluate_policy(policy_dir: Path, matchup_target: str, seed_set_id: str, output_dir: Path, timeout_sec: int) -> Dict[str, Any]:
    cmd = [
        "bun",
        "tools/ai/scripts/checkpoint-eval.ts",
        "--checkpointDir",
        str(policy_dir),
        "--matchupTarget",
        matchup_target,
        "--seedSetId",
        seed_set_id,
        "--outputDir",
        str(output_dir),
    ]
    subprocess.run(cmd, cwd=REPO_DIR, check=True, timeout=timeout_sec)
    return json.loads((output_dir / "summary.json").read_text(encoding="utf-8"))


def copy_flagged_replays(eval_dir: Path, replay_dir: Path, matchup_target: str) -> None:
    flagged_dir = eval_dir / "flagged"
    replay_dir.mkdir(parents=True, exist_ok=True)
    for artifact in flagged_dir.glob("*.json"):
        shutil.copy2(artifact, replay_dir / f"{matchup_target}-{artifact.name}")


def save_trainer_checkpoint(
    path: Path,
    actor_critic: ActorCriticModel,
    optimizer: torch.optim.Optimizer,
    update_index: int,
    total_env_steps: int,
    completed_episodes: int,
    config: ResolvedConfig,
    init_checkpoint_dir: Path,
    init_metadata: Dict[str, Any],
    input_mean: np.ndarray,
    input_std: np.ndarray,
    current_seed: int,
    next_observations: Dict[str, np.ndarray],
    next_masks: Dict[str, np.ndarray],
    pending_replay: Dict[str, Any],
    episode_return_accumulator: Dict[str, float],
    torch_generator: torch.Generator,
    active_opponent_id: str = "self-current",
) -> None:
    numpy_state = np.random.get_state()
    torch.save(
        {
            "actor_critic_state_dict": actor_critic.state_dict(),
            "optimizer_state_dict": optimizer.state_dict(),
            "update_index": update_index,
            "total_env_steps": total_env_steps,
            "completed_episodes": completed_episodes,
            "preset": config.preset_name,
            "init_checkpoint_dir": str(init_checkpoint_dir),
            "init_metadata": init_metadata,
            "input_mean": input_mean.tolist(),
            "input_std": input_std.tolist(),
            "current_seed": current_seed,
            "next_observations": {player_id: values.tolist() for player_id, values in next_observations.items()},
            "next_masks": {player_id: values.astype(bool).tolist() for player_id, values in next_masks.items()},
            "pending_replay": pending_replay,
            "episode_return_accumulator": episode_return_accumulator,
            "torch_rng_state": torch.get_rng_state(),
            "torch_generator_state": torch_generator.get_state(),
            "active_opponent_id": active_opponent_id,
            "numpy_rng_state": {
                "algorithm": numpy_state[0],
                "keys": numpy_state[1].tolist(),
                "pos": int(numpy_state[2]),
                "has_gauss": int(numpy_state[3]),
                "cached_gaussian": float(numpy_state[4]),
            },
        },
        path,
    )


def load_resume_checkpoint(path: Path, actor_critic: ActorCriticModel, optimizer: torch.optim.Optimizer) -> Dict[str, Any]:
    payload = torch.load(path, map_location="cpu")
    actor_critic.load_state_dict(payload["actor_critic_state_dict"])
    optimizer.load_state_dict(payload["optimizer_state_dict"])
    return payload


def parse_runtime_checkpoint_state(payload: Dict[str, Any]) -> RuntimeCheckpointState:
    numpy_rng_state = payload["numpy_rng_state"]
    return RuntimeCheckpointState(
        init_metadata=payload["init_metadata"],
        input_mean=np.asarray(payload["input_mean"], dtype=np.float32),
        input_std=np.asarray(payload["input_std"], dtype=np.float32),
        current_seed=int(payload["current_seed"]),
        next_observations={
            player_id: np.asarray(values, dtype=np.float32)
            for player_id, values in payload["next_observations"].items()
        },
        next_masks={
            player_id: np.asarray(values, dtype=np.bool_)
            for player_id, values in payload["next_masks"].items()
        },
        pending_replay=payload["pending_replay"],
        episode_return_accumulator={
            "p1": float(payload["episode_return_accumulator"]["p1"]),
            "p2": float(payload["episode_return_accumulator"]["p2"]),
        },
        torch_rng_state=payload["torch_rng_state"],
        torch_generator_state=payload["torch_generator_state"],
        numpy_rng_state={
            "algorithm": str(numpy_rng_state["algorithm"]),
            "keys": np.asarray(numpy_rng_state["keys"], dtype=np.uint32),
            "pos": int(numpy_rng_state["pos"]),
            "has_gauss": int(numpy_rng_state["has_gauss"]),
            "cached_gaussian": float(numpy_rng_state["cached_gaussian"]),
        },
        active_opponent_id=str(payload.get("active_opponent_id", "self-current")),
    )


def restore_rng_state(runtime_state: RuntimeCheckpointState, generator: torch.Generator) -> None:
    np.random.set_state(
        (
            runtime_state.numpy_rng_state["algorithm"],
            runtime_state.numpy_rng_state["keys"],
            runtime_state.numpy_rng_state["pos"],
            runtime_state.numpy_rng_state["has_gauss"],
            runtime_state.numpy_rng_state["cached_gaussian"],
        )
    )
    torch.set_rng_state(runtime_state.torch_rng_state)
    generator.set_state(runtime_state.torch_generator_state)


def enforce_resume_contract(config: ResolvedConfig, runtime_state: RuntimeCheckpointState) -> None:
    resumed_init_dir = str(config.init_checkpoint_dir.resolve())
    original_init_dir = str(Path(runtime_state.init_metadata["sourceCheckpointDir"]).resolve())
    if resumed_init_dir != original_init_dir:
        raise ValueError(
            f"Resume init checkpoint mismatch: checkpoint was created from {original_init_dir}, received {resumed_init_dir}"
        )


def restore_bridge_state(bridge: BridgeClient, runtime_state: RuntimeCheckpointState) -> tuple[Dict[str, np.ndarray], Dict[str, np.ndarray]]:
    replay = runtime_state.pending_replay
    reset_result = bridge.reset(int(replay["effectiveSeed"]))
    for decision_step in replay["decisionSteps"]:
        bridge.step(decision_step["actions"])

    restored_observations = {
        player_id: np.asarray(reset_result["observations"][player_id], dtype=np.float32)
        for player_id in PLAYER_IDS
    }
    if replay["decisionSteps"]:
        latest_replay = bridge.capture_replay()
        if latest_replay["decisionSteps"] != replay["decisionSteps"]:
            raise RuntimeError("Failed to restore bridge replay state during resume")
        observation_response = {
            player_id: np.asarray(bridge.get_observation(player_id)["observation"], dtype=np.float32)
            for player_id in PLAYER_IDS
        }
        mask_response = {
            player_id: np.asarray(bridge.get_action_mask(player_id)["actionMask"], dtype=np.bool_)
            for player_id in PLAYER_IDS
        }
        restored_observations = observation_response
        restored_masks = mask_response
    else:
        restored_masks = {
            player_id: np.asarray(reset_result["actionMasks"][player_id], dtype=np.bool_)
            for player_id in PLAYER_IDS
        }

    for player_id in PLAYER_IDS:
        if not np.array_equal(restored_observations[player_id], runtime_state.next_observations[player_id]):
            raise RuntimeError(f"Observation mismatch while restoring resume state for {player_id}")
        if not np.array_equal(restored_masks[player_id], runtime_state.next_masks[player_id]):
            raise RuntimeError(f"Action mask mismatch while restoring resume state for {player_id}")

    return restored_observations, restored_masks


def collect_rollout(
    actor_critic: ActorCriticModel,
    bridge: BridgeClient,
    opponent_pool: OpponentPoolManager,
    horizon: int,
    current_seed: int,
    next_observations: Dict[str, np.ndarray],
    next_masks: Dict[str, np.ndarray],
    input_mean: np.ndarray,
    input_std: np.ndarray,
    generator: torch.Generator,
    episode_return_accumulator: Dict[str, float],
) -> Dict[str, Any]:
    obs_buffer: List[np.ndarray] = []
    mask_buffer: List[np.ndarray] = []
    action_buffer: List[np.ndarray] = []
    log_prob_buffer: List[np.ndarray] = []
    value_buffer: List[np.ndarray] = []
    reward_buffer: List[np.ndarray] = []
    done_buffer: List[float] = []
    episode_returns: List[float] = []
    total_env_steps = 0
    completed_episodes = 0
    normalized_next_obs = None

    for _step in range(horizon):
        player_obs = np.stack([next_observations[player_id] for player_id in PLAYER_IDS], axis=0)
        player_masks = np.stack([next_masks[player_id] for player_id in PLAYER_IDS], axis=0)
        normalized = normalize_observations(player_obs, input_mean, input_std)
        normalized_next_obs = normalized
        obs_tensor = torch.from_numpy(normalized)
        mask_tensor = torch.from_numpy(player_masks.astype(np.bool_))
        with torch.no_grad():
            logits, values = actor_critic(obs_tensor)
            actions, log_probs, _entropy = masked_sample(logits, mask_tensor, generator=generator)

        if opponent_pool.enabled:
            chosen_actions = {
                "p1": INDEX_TO_ACTION[int(actions[0].item())],
                "p2": opponent_pool.select_action(
                    actor_critic,
                    next_observations["p2"],
                    next_masks["p2"],
                    generator,
                    input_mean,
                    input_std,
                ),
            }
        else:
            chosen_actions = {player_id: INDEX_TO_ACTION[int(actions[index].item())] for index, player_id in enumerate(PLAYER_IDS)}
        step_result = bridge.step(chosen_actions)

        if opponent_pool.enabled:
            obs_buffer.append(normalized[:1])
            mask_buffer.append(player_masks[:1].astype(np.bool_))
            action_buffer.append(actions[:1].cpu().numpy().astype(np.int64))
            log_prob_buffer.append(log_probs[:1].cpu().numpy().astype(np.float32))
            value_buffer.append(values[:1].cpu().numpy().astype(np.float32))
            reward_buffer.append(np.asarray([step_result["rewards"]["p1"]], dtype=np.float32))
        else:
            obs_buffer.append(normalized)
            mask_buffer.append(player_masks.astype(np.bool_))
            action_buffer.append(actions.cpu().numpy().astype(np.int64))
            log_prob_buffer.append(log_probs.cpu().numpy().astype(np.float32))
            value_buffer.append(values.cpu().numpy().astype(np.float32))
            reward_buffer.append(np.asarray([step_result["rewards"]["p1"], step_result["rewards"]["p2"]], dtype=np.float32))
        done_buffer.append(1.0 if step_result["done"] else 0.0)

        total_env_steps += 1
        episode_return_accumulator["p1"] += step_result["rewards"]["p1"]
        episode_return_accumulator["p2"] += step_result["rewards"]["p2"]

        if step_result["done"]:
            episode_returns.extend([episode_return_accumulator["p1"], episode_return_accumulator["p2"]])
            episode_return_accumulator = {"p1": 0.0, "p2": 0.0}
            completed_episodes += 1
            current_seed += 1
            reset_result = bridge.reset(current_seed)
            opponent_pool.select_for_episode()
            next_observations = {player_id: np.asarray(reset_result["observations"][player_id], dtype=np.float32) for player_id in PLAYER_IDS}
            next_masks = {player_id: np.asarray(reset_result["actionMasks"][player_id], dtype=np.bool_) for player_id in PLAYER_IDS}
        else:
            next_observations = {player_id: np.asarray(step_result["observations"][player_id], dtype=np.float32) for player_id in PLAYER_IDS}
            next_masks = {player_id: np.asarray(step_result["actionMasks"][player_id], dtype=np.bool_) for player_id in PLAYER_IDS}

    if normalized_next_obs is None:
        raise RuntimeError("Rollout horizon must be positive")

    bootstrap_obs = np.stack([next_observations[player_id] for player_id in PLAYER_IDS], axis=0)
    bootstrap_normalized = normalize_observations(bootstrap_obs, input_mean, input_std)
    bootstrap_mask = np.stack([next_masks[player_id] for player_id in PLAYER_IDS], axis=0)
    with torch.no_grad():
        _bootstrap_logits, bootstrap_values = actor_critic(torch.from_numpy(bootstrap_normalized))
    if opponent_pool.enabled:
        bootstrap_values = bootstrap_values[:1]
        bootstrap_mask = bootstrap_mask[:1]

    return {
        "obs": np.asarray(obs_buffer, dtype=np.float32),
        "masks": np.asarray(mask_buffer, dtype=np.bool_),
        "actions": np.asarray(action_buffer, dtype=np.int64),
        "log_probs": np.asarray(log_prob_buffer, dtype=np.float32),
        "values": np.asarray(value_buffer, dtype=np.float32),
        "rewards": np.asarray(reward_buffer, dtype=np.float32),
        "dones": np.asarray(done_buffer, dtype=np.float32),
        "bootstrap_values": bootstrap_values.cpu().numpy().astype(np.float32),
        "bootstrap_masks": bootstrap_mask.astype(np.bool_),
        "next_observations": next_observations,
        "next_masks": next_masks,
        "current_seed": current_seed,
        "total_env_steps": total_env_steps,
        "completed_episodes": completed_episodes,
        "episode_returns": episode_returns,
        "episode_return_accumulator": episode_return_accumulator,
    }


def compute_gae(rollout: Dict[str, Any], gamma: float, gae_lambda: float) -> Dict[str, np.ndarray]:
    rewards = rollout["rewards"]
    values = rollout["values"]
    dones = rollout["dones"]
    bootstrap_values = rollout["bootstrap_values"]
    advantages = np.zeros_like(rewards, dtype=np.float32)
    last_advantage = np.zeros(rewards.shape[1], dtype=np.float32)
    next_values = bootstrap_values

    for step in range(rewards.shape[0] - 1, -1, -1):
        not_done = 1.0 - dones[step]
        delta = rewards[step] + gamma * next_values * not_done - values[step]
        last_advantage = delta + gamma * gae_lambda * not_done * last_advantage
        advantages[step] = last_advantage
        next_values = values[step]

    returns = advantages + values
    return {"advantages": advantages, "returns": returns}


def ppo_update(
    actor_critic: ActorCriticModel,
    optimizer: torch.optim.Optimizer,
    rollout: Dict[str, Any],
    gae: Dict[str, np.ndarray],
    config: Dict[str, Any],
    hard_state_batch: HardStateBatch | None = None,
) -> Dict[str, float]:
    obs = torch.from_numpy(rollout["obs"].reshape(-1, rollout["obs"].shape[-1]))
    masks = torch.from_numpy(rollout["masks"].reshape(-1, rollout["masks"].shape[-1]))
    actions = torch.from_numpy(rollout["actions"].reshape(-1))
    old_log_probs = torch.from_numpy(rollout["log_probs"].reshape(-1))
    returns = torch.from_numpy(gae["returns"].reshape(-1))
    advantages = torch.from_numpy(gae["advantages"].reshape(-1))
    values_before = rollout["values"].reshape(-1)

    advantages = (advantages - advantages.mean()) / (advantages.std(unbiased=False) + 1e-8)
    minibatch_size = int(config["minibatchSize"])
    policy_losses: List[float] = []
    value_losses: List[float] = []
    entropies: List[float] = []

    for _epoch in range(int(config["ppoEpochs"])):
        permutation = torch.randperm(obs.shape[0])
        for start in range(0, obs.shape[0], minibatch_size):
            batch_indices = permutation[start:start + minibatch_size]
            batch_obs = obs[batch_indices]
            batch_masks = masks[batch_indices]
            batch_actions = actions[batch_indices]
            batch_old_log_probs = old_log_probs[batch_indices]
            batch_returns = returns[batch_indices]
            batch_advantages = advantages[batch_indices]

            logits, values = actor_critic(batch_obs)
            safe_logits = logits.masked_fill(~batch_masks.bool(), -1e9)
            distribution = torch.distributions.Categorical(logits=safe_logits)
            log_probs = distribution.log_prob(batch_actions)
            entropy = distribution.entropy().mean()
            ratio = torch.exp(log_probs - batch_old_log_probs)
            clipped_ratio = torch.clamp(ratio, 1.0 - config["clipRange"], 1.0 + config["clipRange"])
            policy_loss = -torch.min(ratio * batch_advantages, clipped_ratio * batch_advantages).mean()
            value_loss = torch.nn.functional.mse_loss(values, batch_returns)
            loss = policy_loss + config["valueCoef"] * value_loss - config["entropyCoef"] * entropy

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(actor_critic.parameters(), config["maxGradNorm"])
            optimizer.step()

            policy_losses.append(float(policy_loss.item()))
            value_losses.append(float(value_loss.item()))
            entropies.append(float(entropy.item()))

    explained_variance = compute_explained_variance(gae["returns"].reshape(-1), values_before)
    hard_state_loss = None
    hard_state_config = config.get("hardStateReuse", {})
    if hard_state_config.get("enabled", False) and hard_state_batch is not None:
        aux_batch_size = min(minibatch_size, hard_state_batch.observations.shape[0])
        aux_indices = np.random.choice(hard_state_batch.observations.shape[0], size=aux_batch_size, replace=False)
        aux_obs = torch.from_numpy(hard_state_batch.observations[aux_indices])
        aux_masks = torch.from_numpy(hard_state_batch.action_masks[aux_indices])
        aux_actions = torch.from_numpy(hard_state_batch.actions[aux_indices])
        logits, _values = actor_critic(aux_obs)
        bc_loss = F.cross_entropy(masked_logits(logits, aux_masks), aux_actions)
        weighted_bc_loss = float(hard_state_config.get("bcWeight", 0.1)) * bc_loss
        optimizer.zero_grad()
        weighted_bc_loss.backward()
        torch.nn.utils.clip_grad_norm_(actor_critic.parameters(), config["maxGradNorm"])
        optimizer.step()
        hard_state_loss = float(bc_loss.item())
    return {
        "policy_loss": float(np.mean(policy_losses)),
        "value_loss": float(np.mean(value_losses)),
        "entropy": float(np.mean(entropies)),
        "explained_variance": explained_variance,
        "hard_state_loss": hard_state_loss,
    }


def main() -> int:
    args = parse_args()
    config = load_config(Path(args.config), args.preset, args.init_checkpoint)
    set_deterministic_seed(int(config.values["seed"]))
    started_at = time.monotonic()

    init_checkpoint = load_policy_checkpoint(config.init_checkpoint_dir)
    actor_critic = initialize_actor_critic_from_policy(init_checkpoint)
    optimizer = torch.optim.Adam(actor_critic.parameters(), lr=float(config.values["learningRate"]))

    run_id = args.run_id or make_run_id(config.preset_name)
    run_dir = Path(args.output_dir).resolve() if args.output_dir else (RUNS_DIR / run_id).resolve()
    policy_dir = run_dir / "policy"
    trainer_checkpoint_path = run_dir / "trainer_checkpoint.pt"
    metrics_path = run_dir / "metrics.jsonl"
    latest_path = run_dir / "latest.json"

    run_dir.mkdir(parents=True, exist_ok=True)
    resolved_config_payload = {
        "configPath": str(config.source_path),
        "preset": config.preset_name,
        "values": config.values,
        "initCheckpointDir": str(config.init_checkpoint_dir),
    }
    write_json(run_dir / "config.json", resolved_config_payload)

    update_index = 0
    total_env_steps = 0
    completed_episodes = 0
    runtime_state: RuntimeCheckpointState | None = None
    if args.resume_from:
        resume_payload = load_resume_checkpoint(Path(args.resume_from).resolve(), actor_critic, optimizer)
        runtime_state = parse_runtime_checkpoint_state(resume_payload)
        enforce_resume_contract(config, runtime_state)
        update_index = int(resume_payload["update_index"])
        total_env_steps = int(resume_payload["total_env_steps"])
        completed_episodes = int(resume_payload["completed_episodes"])

    generator = torch.Generator().manual_seed(int(config.values["seed"]))
    bridge = BridgeClient(REPO_DIR)
    opponent_pool = OpponentPoolManager(config.values, config.init_checkpoint_dir, run_dir)
    try:
        if runtime_state is not None:
            restore_rng_state(runtime_state, generator)
            current_seed = runtime_state.current_seed
            next_observations, next_masks = restore_bridge_state(bridge, runtime_state)
            normalization_mean = runtime_state.input_mean
            normalization_std = runtime_state.input_std
            export_init_metadata = runtime_state.init_metadata
            episode_return_accumulator = dict(runtime_state.episode_return_accumulator)
            opponent_pool.restore(runtime_state.active_opponent_id)
        else:
            current_seed = int(config.values["seed"])
            reset_result = bridge.reset(current_seed)
            next_observations = {player_id: np.asarray(reset_result["observations"][player_id], dtype=np.float32) for player_id in PLAYER_IDS}
            next_masks = {player_id: np.asarray(reset_result["actionMasks"][player_id], dtype=np.bool_) for player_id in PLAYER_IDS}
            normalization_mean = init_checkpoint.input_mean
            normalization_std = init_checkpoint.input_std
            export_init_metadata = dict(init_checkpoint.metadata)
            export_init_metadata["sourceCheckpointDir"] = str(config.init_checkpoint_dir.resolve())
            episode_return_accumulator = {"p1": 0.0, "p2": 0.0}
            opponent_pool.select_for_episode()

        hard_state_batch: HardStateBatch | None = None

        while update_index < int(config.values["totalUpdates"]):
            if time.monotonic() - started_at > int(config.values["overallTimeoutSec"]):
                raise TimeoutError("RL training exceeded overall timeout")

            rollout = collect_rollout(
                actor_critic=actor_critic,
                bridge=bridge,
                opponent_pool=opponent_pool,
                horizon=int(config.values["rolloutHorizon"]),
                current_seed=current_seed,
                next_observations=next_observations,
                next_masks=next_masks,
                input_mean=normalization_mean,
                input_std=normalization_std,
                generator=generator,
                episode_return_accumulator=episode_return_accumulator,
            )
            next_observations = rollout["next_observations"]
            next_masks = rollout["next_masks"]
            current_seed = int(rollout["current_seed"])
            total_env_steps += int(rollout["total_env_steps"])
            completed_episodes += int(rollout["completed_episodes"])
            episode_return_accumulator = dict(rollout["episode_return_accumulator"])

            gae = compute_gae(rollout, gamma=float(config.values["gamma"]), gae_lambda=float(config.values["gaeLambda"]))
            update_metrics = ppo_update(actor_critic, optimizer, rollout, gae, config.values, hard_state_batch)
            update_index += 1

            export_policy_checkpoint(
                policy_dir,
                run_id,
                update_index,
                actor_critic,
                export_init_metadata,
                normalization_mean,
                normalization_std,
            )
            save_trainer_checkpoint(
                trainer_checkpoint_path,
                actor_critic,
                optimizer,
                update_index,
                total_env_steps,
                completed_episodes,
                config,
                config.init_checkpoint_dir,
                export_init_metadata,
                normalization_mean,
                normalization_std,
                current_seed,
                next_observations,
                next_masks,
                bridge.capture_replay(),
                episode_return_accumulator,
                generator,
                opponent_pool.active_opponent_id,
            )

            metrics_record: Dict[str, Any] = {
                "updateIndex": update_index,
                "totalEnvSteps": total_env_steps,
                "policyLoss": update_metrics["policy_loss"],
                "valueLoss": update_metrics["value_loss"],
                "entropy": update_metrics["entropy"],
                "explainedVariance": update_metrics["explained_variance"],
                "averageEpisodicReturn": float(np.mean(rollout["episode_returns"])) if rollout["episode_returns"] else 0.0,
                "activeOpponent": opponent_pool.active_opponent_id,
            }
            if update_metrics["hard_state_loss"] is not None:
                metrics_record["hardStateLoss"] = update_metrics["hard_state_loss"]

            if update_index % int(config.values["evalEveryUpdates"]) == 0:
                eval_root = run_dir / "evals" / str(update_index)
                random_eval_dir = eval_root / f"random-safe-{config.values['randomSafeSeedSetId']}"
                heuristic_eval_dir = eval_root / f"heuristic-{config.values['heuristicSeedSetId']}"
                random_eval = evaluate_policy(policy_dir, "random-safe", str(config.values["randomSafeSeedSetId"]), random_eval_dir, int(config.values["evalTimeoutSec"]))
                heuristic_eval = evaluate_policy(policy_dir, "heuristic", str(config.values["heuristicSeedSetId"]), heuristic_eval_dir, int(config.values["evalTimeoutSec"]))
                copy_flagged_replays(random_eval_dir, run_dir / "replays" / str(update_index) / "flagged", "random-safe")
                copy_flagged_replays(heuristic_eval_dir, run_dir / "replays" / str(update_index) / "flagged", "heuristic")
                hard_state_batch = maybe_refresh_hard_state_batch(run_dir, update_index, heuristic_eval_dir, config.values) or hard_state_batch
                metrics_record["periodicEvalWinRates"] = {
                    "randomSafe": random_eval["metrics"]["winRate"],
                    "heuristic": heuristic_eval["metrics"]["winRate"],
                }
                if hard_state_batch is not None:
                    metrics_record["hardStateReuse"] = {
                        "sourceDir": hard_state_batch.source_dir,
                        "sampleCount": int(hard_state_batch.observations.shape[0]),
                    }
                best_checkpoint = maybe_update_best_checkpoint(
                    run_dir=run_dir,
                    run_id=run_id,
                    update_index=update_index,
                    policy_dir=policy_dir,
                    heuristic_eval=heuristic_eval,
                    random_safe_eval=random_eval,
                )
                if best_checkpoint is not None:
                    metrics_record["bestCheckpoint"] = {
                        "updateIndex": best_checkpoint["updateIndex"],
                        "heuristicWinRate": best_checkpoint["heuristicWinRate"],
                    }

            append_jsonl(metrics_path, metrics_record)
            write_json(
                latest_path,
                {
                    "runId": run_id,
                    "latestUpdate": update_index,
                    "policyDir": str(policy_dir),
                    "trainerCheckpoint": str(trainer_checkpoint_path),
                    "metricsPath": str(metrics_path),
                    "bestCheckpointPath": str(run_dir / "best-checkpoint.json"),
                },
            )
            print(json.dumps(metrics_record), flush=True)
    finally:
        bridge.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
