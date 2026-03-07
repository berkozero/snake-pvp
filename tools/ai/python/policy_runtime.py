from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict

import numpy as np
import torch

from common import INDEX_TO_ACTION, ensure_contract, load_checkpoint, load_training_config, masked_argmax, normalize_observation


training_config = load_training_config()
loaded: Dict[str, Any] | None = None


def respond(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def handle_load(request_id: str, checkpoint_dir: str) -> None:
    global loaded
    checkpoint = load_checkpoint(Path(checkpoint_dir))
    ensure_contract(checkpoint["metadata"], training_config)
    loaded = checkpoint
    respond({"id": request_id, "type": "loaded", "metadata": checkpoint["metadata"]})


def handle_metadata(request_id: str) -> None:
    if loaded is None:
        raise RuntimeError("Checkpoint must be loaded before metadata is requested")
    respond({"id": request_id, "type": "loaded", "metadata": loaded["metadata"]})


def handle_act(request_id: str, observation: list[float], action_mask: list[bool]) -> None:
    if loaded is None:
        raise RuntimeError("Checkpoint must be loaded before inference")
    if len(observation) != training_config["observationLength"]:
        raise ValueError("Observation length drifted from the frozen contract")
    if len(action_mask) != len(training_config["actionOrder"]):
        raise ValueError("Action mask length drifted from the frozen contract")

    normalized = normalize_observation(
        np.asarray(observation, dtype=np.float32),
        loaded["input_mean"],
        loaded["input_std"],
    )
    obs_tensor = torch.from_numpy(normalized).unsqueeze(0)
    mask_tensor = torch.tensor(action_mask, dtype=torch.bool).unsqueeze(0)
    with torch.no_grad():
        logits = loaded["model"](obs_tensor)
        action_index = int(masked_argmax(logits, mask_tensor).item())
    respond({"id": request_id, "type": "action", "action": INDEX_TO_ACTION[action_index]})


def main() -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request: Dict[str, Any] = json.loads(line)
        request_id = str(request.get("id", "unknown"))
        try:
            request_type = request["type"]
            if request_type == "load":
                handle_load(request_id, str(request["checkpointDir"]))
            elif request_type == "metadata":
                handle_metadata(request_id)
            elif request_type == "act":
                handle_act(request_id, request["observation"], request["actionMask"])
            else:
                raise ValueError(f"Unsupported request type: {request_type}")
        except Exception as error:  # noqa: BLE001
            respond({"id": request_id, "type": "error", "error": str(error)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
