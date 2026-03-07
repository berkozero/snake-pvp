from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import torch
from torch import nn


ROOT_DIR = Path(__file__).resolve().parent.parent
TRAINING_CONFIG_PATH = ROOT_DIR / "configs" / "training-config.json"
ACTION_TO_INDEX = {"up": 0, "down": 1, "left": 2, "right": 3, "stay": 4}
INDEX_TO_ACTION = {index: action for action, index in ACTION_TO_INDEX.items()}


def load_training_config() -> Dict[str, Any]:
    return json.loads(TRAINING_CONFIG_PATH.read_text(encoding="utf-8"))


def ensure_python_stack_versions() -> Dict[str, str]:
    return {
        "numpy": np.__version__,
        "torch": torch.__version__,
    }


def create_model(
    input_size: int = 44,
    hidden_sizes: List[int] | None = None,
    output_size: int = 5,
) -> nn.Module:
    if hidden_sizes is None:
        hidden_sizes = [16]

    layers: List[nn.Module] = []
    next_input_size = input_size
    for hidden_size in hidden_sizes:
        layers.append(nn.Linear(next_input_size, hidden_size))
        layers.append(nn.ReLU())
        next_input_size = hidden_size
    layers.append(nn.Linear(next_input_size, output_size))
    return nn.Sequential(*layers)


def set_deterministic_seed(seed: int) -> None:
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)


def masked_argmax(logits: torch.Tensor, action_masks: torch.Tensor) -> torch.Tensor:
    masked_logits = logits.masked_fill(~action_masks.bool(), float("-inf"))
    return torch.argmax(masked_logits, dim=1)


def load_checkpoint(checkpoint_dir: Path) -> Dict[str, Any]:
    metadata_path = checkpoint_dir / "metadata.json"
    model_path = checkpoint_dir / "model.pt"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    payload = torch.load(model_path, map_location="cpu")
    hidden_sizes = metadata.get("hiddenSizes")
    if hidden_sizes is None:
        hidden_sizes = [metadata["hiddenSize"]]
    model = create_model(input_size=metadata["inputSize"], hidden_sizes=hidden_sizes, output_size=metadata["outputSize"])
    model.load_state_dict(payload["state_dict"])
    model.eval()
    return {
        "metadata": metadata,
        "model": model,
        "input_mean": np.asarray(payload["input_mean"], dtype=np.float32),
        "input_std": np.asarray(payload["input_std"], dtype=np.float32),
    }


def normalize_observation(observation: np.ndarray, input_mean: np.ndarray, input_std: np.ndarray) -> np.ndarray:
    return (observation - input_mean) / input_std


def ensure_contract(metadata: Dict[str, Any], training_config: Dict[str, Any]) -> None:
    if metadata["observationVersion"] != training_config["observationVersion"]:
        raise ValueError("Checkpoint observationVersion drifted from the frozen contract")
    if metadata["inputSize"] != training_config["observationLength"]:
        raise ValueError("Checkpoint inputSize drifted from the frozen contract")
    if metadata["actionOrder"] != training_config["actionOrder"]:
        raise ValueError("Checkpoint actionOrder drifted from the frozen contract")
