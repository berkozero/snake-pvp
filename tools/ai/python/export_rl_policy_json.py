from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict

from rl_core import EXPECTED_ACTION_ORDER, EXPECTED_HIDDEN_SIZES, EXPORT_VERSION, load_policy_checkpoint


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint-dir", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def tensor_to_list(value: Any) -> Any:
    if hasattr(value, "detach"):
        return value.detach().cpu().tolist()
    return value


def build_payload(checkpoint_dir: Path) -> Dict[str, Any]:
    checkpoint = load_policy_checkpoint(checkpoint_dir)
    metadata = checkpoint.metadata
    hidden_sizes = metadata.get("hiddenSizes", [metadata.get("hiddenSize")])
    if hidden_sizes != EXPECTED_HIDDEN_SIZES:
        raise ValueError(f"Expected hidden sizes {EXPECTED_HIDDEN_SIZES}, received {hidden_sizes}")
    if metadata["actionOrder"] != EXPECTED_ACTION_ORDER:
        raise ValueError("Action order drifted from the frozen contract")

    state_dict = checkpoint.payload["state_dict"]
    return {
        "schemaVersion": EXPORT_VERSION,
        "metadata": metadata,
        "inputMean": checkpoint.input_mean.tolist(),
        "inputStd": checkpoint.input_std.tolist(),
        "layers": [
            {
                "weight": tensor_to_list(state_dict["0.weight"]),
                "bias": tensor_to_list(state_dict["0.bias"]),
                "activation": "relu",
            },
            {
                "weight": tensor_to_list(state_dict["2.weight"]),
                "bias": tensor_to_list(state_dict["2.bias"]),
                "activation": "relu",
            },
            {
                "weight": tensor_to_list(state_dict["4.weight"]),
                "bias": tensor_to_list(state_dict["4.bias"]),
                "activation": "identity",
            },
        ],
    }


def main() -> int:
    args = parse_args()
    checkpoint_dir = Path(args.checkpoint_dir).resolve()
    output_path = Path(args.output).resolve()

    payload = build_payload(checkpoint_dir)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
