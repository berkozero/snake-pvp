from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
import torch
from torch import nn


EXPECTED_ACTION_ORDER = ["up", "down", "left", "right", "stay"]
EXPECTED_HIDDEN_SIZES = [32, 32]
EXPECTED_INPUT_SIZE = 44
EXPECTED_OUTPUT_SIZE = 5
EXPECTED_OBSERVATION_VERSION = 2
EXPORT_VERSION = "rl-policy-v1"


@dataclass(frozen=True)
class PolicyCheckpoint:
    checkpoint_dir: Path
    metadata: Dict[str, Any]
    payload: Dict[str, Any]
    input_mean: np.ndarray
    input_std: np.ndarray


class ActorCriticModel(nn.Module):
    def __init__(self, input_size: int = EXPECTED_INPUT_SIZE, hidden_sizes: List[int] | None = None, output_size: int = EXPECTED_OUTPUT_SIZE) -> None:
        super().__init__()
        sizes = hidden_sizes or EXPECTED_HIDDEN_SIZES
        if sizes != EXPECTED_HIDDEN_SIZES:
            raise ValueError(f"Expected hidden sizes {EXPECTED_HIDDEN_SIZES}, received {sizes}")
        self.trunk = nn.Sequential(
            nn.Linear(input_size, sizes[0]),
            nn.ReLU(),
            nn.Linear(sizes[0], sizes[1]),
            nn.ReLU(),
        )
        self.policy_head = nn.Linear(sizes[-1], output_size)
        self.value_head = nn.Linear(sizes[-1], 1)

    def forward(self, observations: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        hidden = self.trunk(observations)
        return self.policy_head(hidden), self.value_head(hidden).squeeze(-1)


def load_policy_checkpoint(checkpoint_dir: Path) -> PolicyCheckpoint:
    metadata = json.loads((checkpoint_dir / "metadata.json").read_text(encoding="utf-8"))
    payload = torch.load(checkpoint_dir / "model.pt", map_location="cpu")
    return PolicyCheckpoint(
        checkpoint_dir=checkpoint_dir,
        metadata=metadata,
        payload=payload,
        input_mean=np.asarray(payload["input_mean"], dtype=np.float32),
        input_std=np.asarray(payload["input_std"], dtype=np.float32),
    )


def validate_init_checkpoint(metadata: Dict[str, Any]) -> None:
    if metadata["observationVersion"] != EXPECTED_OBSERVATION_VERSION:
        raise ValueError("Init checkpoint observationVersion drifted from the frozen contract")
    if metadata["inputSize"] != EXPECTED_INPUT_SIZE:
        raise ValueError("Init checkpoint inputSize drifted from the frozen contract")
    if metadata.get("hiddenSizes", [metadata.get("hiddenSize")]) != EXPECTED_HIDDEN_SIZES:
        raise ValueError("Init checkpoint hiddenSizes drifted from the frozen contract")
    if metadata["outputSize"] != EXPECTED_OUTPUT_SIZE:
        raise ValueError("Init checkpoint outputSize drifted from the frozen contract")
    if metadata["actionOrder"] != EXPECTED_ACTION_ORDER:
        raise ValueError("Init checkpoint actionOrder drifted from the frozen contract")


def initialize_actor_critic_from_policy(checkpoint: PolicyCheckpoint) -> ActorCriticModel:
    validate_init_checkpoint(checkpoint.metadata)
    model = ActorCriticModel()
    state_dict = checkpoint.payload["state_dict"]
    model.trunk[0].weight.data.copy_(state_dict["0.weight"])
    model.trunk[0].bias.data.copy_(state_dict["0.bias"])
    model.trunk[2].weight.data.copy_(state_dict["2.weight"])
    model.trunk[2].bias.data.copy_(state_dict["2.bias"])
    model.policy_head.weight.data.copy_(state_dict["4.weight"])
    model.policy_head.bias.data.copy_(state_dict["4.bias"])
    nn.init.zeros_(model.value_head.weight)
    nn.init.zeros_(model.value_head.bias)
    return model


def normalize_observations(observations: np.ndarray, input_mean: np.ndarray, input_std: np.ndarray) -> np.ndarray:
    return ((observations - input_mean) / input_std).astype(np.float32)


def masked_logits(logits: torch.Tensor, action_masks: torch.Tensor) -> torch.Tensor:
    masks = action_masks.bool()
    if not torch.all(masks.any(dim=-1)):
        raise ValueError("Received an action mask with no legal actions")
    return logits.masked_fill(~masks, -1e9)


def masked_sample(logits: torch.Tensor, action_masks: torch.Tensor, generator: torch.Generator | None = None) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    safe_logits = masked_logits(logits, action_masks)
    probabilities = torch.softmax(safe_logits, dim=-1)
    actions = torch.multinomial(probabilities, num_samples=1, generator=generator).squeeze(-1)
    distribution = torch.distributions.Categorical(probs=probabilities)
    log_probs = distribution.log_prob(actions)
    entropy = distribution.entropy()
    return actions, log_probs, entropy


def masked_greedy_actions(logits: torch.Tensor, action_masks: torch.Tensor) -> torch.Tensor:
    safe_logits = masked_logits(logits, action_masks)
    return torch.argmax(safe_logits, dim=-1)


def export_policy_checkpoint(
    output_dir: Path,
    run_id: str,
    update_index: int,
    actor_critic: ActorCriticModel,
    base_metadata: Dict[str, Any],
    input_mean: np.ndarray,
    input_std: np.ndarray,
    train_origin: str = "rl-ppo",
) -> Dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    model_state = {
        "0.weight": actor_critic.trunk[0].weight.detach().cpu(),
        "0.bias": actor_critic.trunk[0].bias.detach().cpu(),
        "2.weight": actor_critic.trunk[2].weight.detach().cpu(),
        "2.bias": actor_critic.trunk[2].bias.detach().cpu(),
        "4.weight": actor_critic.policy_head.weight.detach().cpu(),
        "4.bias": actor_critic.policy_head.bias.detach().cpu(),
    }
    torch.save(
        {
            "state_dict": model_state,
            "input_mean": input_mean.tolist(),
            "input_std": input_std.tolist(),
        },
        output_dir / "model.pt",
    )
    metadata = dict(base_metadata)
    metadata["runId"] = run_id
    metadata["createdAt"] = datetime.now(timezone.utc).isoformat()
    metadata["checkpointOrigin"] = train_origin
    metadata["exportVersion"] = EXPORT_VERSION
    metadata["modelType"] = "mlp-44x32x32x5"
    metadata["lastRlUpdate"] = update_index
    (output_dir / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata
