from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
import torch
from torch import nn

from common import ACTION_TO_INDEX, create_model, ensure_python_stack_versions, load_training_config, masked_argmax, set_deterministic_seed


ROOT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = ROOT_DIR.parent.parent
ARTIFACTS_DIR = ROOT_DIR / ".local" / "artifacts"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--validation-seed-set-id")
    parser.add_argument("--epochs", type=int, default=250)
    parser.add_argument("--learning-rate", type=float, default=0.01)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--hidden-sizes", default="16")
    parser.add_argument("--supplemental-dataset", action="append", default=[])
    parser.add_argument("--supplemental-weight", action="append", type=float, default=[])
    parser.add_argument("--batch-size", type=int, default=8192)
    return parser.parse_args()


def load_manifest(dataset_dir: Path) -> Dict[str, Any]:
    return json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))


def load_samples(dataset_dir: Path, expected_config: Dict[str, Any]) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    observations: List[List[float]] = []
    action_masks: List[List[bool]] = []
    labels: List[int] = []
    with (dataset_dir / "samples.jsonl").open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            sample = json.loads(line)
            if sample["observationVersion"] != expected_config["observationVersion"]:
                raise ValueError("Dataset observationVersion drifted from the frozen contract")
            if len(sample["observation"]) != expected_config["observationLength"]:
                raise ValueError("Dataset observation length drifted from the frozen contract")
            if len(sample["actionMask"]) != len(expected_config["actionOrder"]):
                raise ValueError("Dataset action mask length drifted from the frozen contract")
            observations.append(sample["observation"])
            action_masks.append(sample["actionMask"])
            labels.append(ACTION_TO_INDEX[sample["teacherAction"]])

    return (
        np.asarray(observations, dtype=np.float32),
        np.asarray(action_masks, dtype=np.bool_),
        np.asarray(labels, dtype=np.int64),
    )


def parse_hidden_sizes(raw_value: str) -> List[int]:
    parts = [part.strip() for part in raw_value.split(",") if part.strip()]
    if not parts:
        raise ValueError("Expected at least one hidden size")
    values = [int(part) for part in parts]
    for value in values:
        if value <= 0:
            raise ValueError(f"Hidden sizes must be positive integers, received {raw_value}")
    return values


def resolve_supplemental_specs(dataset_args: List[str], weight_args: List[float]) -> List[Tuple[Path, float]]:
    if len(dataset_args) != len(weight_args):
        raise ValueError(
            f"Expected the same number of --supplemental-dataset and --supplemental-weight arguments, received {len(dataset_args)} datasets and {len(weight_args)} weights"
        )
    specs: List[Tuple[Path, float]] = []
    for dataset_arg, weight in zip(dataset_args, weight_args):
        if weight <= 0:
            raise ValueError(f"Supplemental weights must be positive, received {weight}")
        specs.append((Path(dataset_arg).resolve(), weight))
    return specs


def ensure_validation_dataset(output_dir: Path, seed_set_id: str) -> Path:
    dataset_dir = output_dir / "validation-dataset"
    cmd = [
        "bun",
        "tools/ai/scripts/generate-dataset.ts",
        "--seedSetId",
        seed_set_id,
        "--outputDir",
        str(dataset_dir),
    ]
    subprocess.run(cmd, cwd=REPO_DIR, check=True)
    return dataset_dir


def run_evaluation(checkpoint_dir: Path, matchup_target: str, seed_set_id: str, output_dir: Path) -> Dict[str, Any]:
    cmd = [
        "bun",
        "tools/ai/scripts/checkpoint-eval.ts",
        "--checkpointDir",
        str(checkpoint_dir),
        "--matchupTarget",
        matchup_target,
        "--seedSetId",
        seed_set_id,
        "--outputDir",
        str(output_dir),
    ]
    subprocess.run(cmd, cwd=REPO_DIR, check=True)
    return json.loads((output_dir / "summary.json").read_text(encoding="utf-8"))


def main() -> int:
    args = parse_args()
    set_deterministic_seed(args.seed)
    training_config = load_training_config()
    hidden_sizes = parse_hidden_sizes(args.hidden_sizes)
    supplemental_specs = resolve_supplemental_specs(args.supplemental_dataset, args.supplemental_weight)
    if args.batch_size <= 0:
        raise ValueError(f"batch-size must be positive, received {args.batch_size}")
    validation_seed_set_id = args.validation_seed_set_id or training_config["milestoneGate"]["validationSeedSetId"]
    gate_seed_set_id = training_config["milestoneGate"]["gateSeedSetId"]
    dataset_dir = Path(args.dataset).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    train_manifest = load_manifest(dataset_dir)
    if train_manifest["observationVersion"] != training_config["observationVersion"]:
        raise ValueError("Training dataset observationVersion drifted from the frozen contract")
    if train_manifest["actionOrder"] != training_config["actionOrder"]:
        raise ValueError("Training dataset actionOrder drifted from the frozen contract")

    validation_dataset_dir = ensure_validation_dataset(output_dir, validation_seed_set_id)

    train_obs, _train_masks, train_labels = load_samples(dataset_dir, training_config)
    train_weights = np.ones(train_labels.shape[0], dtype=np.float32)
    supplemental_metadata: List[Dict[str, Any]] = []
    for supplemental_path, supplemental_weight in supplemental_specs:
        supplemental_manifest = load_manifest(supplemental_path)
        supplemental_obs, _supplemental_masks, supplemental_labels = load_samples(supplemental_path, training_config)
        train_obs = np.concatenate([train_obs, supplemental_obs], axis=0)
        train_labels = np.concatenate([train_labels, supplemental_labels], axis=0)
        train_weights = np.concatenate(
            [
                train_weights,
                np.full(supplemental_labels.shape[0], supplemental_weight, dtype=np.float32),
            ],
            axis=0,
        )
        supplemental_metadata.append(
            {
                "datasetId": supplemental_manifest["datasetId"],
                "seedSetId": supplemental_manifest["seedSetId"],
                "sampleCount": int(supplemental_manifest["sampleCount"]),
                "weight": supplemental_weight,
            }
        )
    val_obs, val_masks, val_labels = load_samples(validation_dataset_dir, training_config)

    input_mean = train_obs.mean(axis=0).astype(np.float32)
    input_std = train_obs.std(axis=0).astype(np.float32)
    input_std[input_std == 0] = 1.0

    train_obs = ((train_obs - input_mean) / input_std).astype(np.float32)
    val_obs = ((val_obs - input_mean) / input_std).astype(np.float32)

    train_obs_tensor = torch.from_numpy(train_obs)
    train_labels_tensor = torch.from_numpy(train_labels)
    train_weights_tensor = torch.from_numpy(train_weights)
    val_obs_tensor = torch.from_numpy(val_obs)
    val_labels_tensor = torch.from_numpy(val_labels)
    val_masks_tensor = torch.from_numpy(val_masks)

    model = create_model(
        input_size=training_config["observationLength"],
        hidden_sizes=hidden_sizes,
        output_size=len(training_config["actionOrder"]),
    )
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    criterion = nn.CrossEntropyLoss(reduction="none")

    final_train_loss = 0.0
    final_validation_loss = 0.0
    validation_accuracy = 0.0

    for _epoch in range(args.epochs):
        model.train()
        permutation = torch.randperm(train_obs_tensor.shape[0])
        weighted_loss_sum = 0.0
        weight_sum = 0.0

        for batch_start in range(0, train_obs_tensor.shape[0], args.batch_size):
            batch_indices = permutation[batch_start: batch_start + args.batch_size]
            batch_obs = train_obs_tensor[batch_indices]
            batch_labels = train_labels_tensor[batch_indices]
            batch_weights = train_weights_tensor[batch_indices]

            optimizer.zero_grad()
            batch_logits = model(batch_obs)
            batch_loss_per_sample = criterion(batch_logits, batch_labels)
            batch_loss = (batch_loss_per_sample * batch_weights).sum() / batch_weights.sum()
            batch_loss.backward()
            optimizer.step()

            weighted_loss_sum += float((batch_loss_per_sample * batch_weights).sum().item())
            weight_sum += float(batch_weights.sum().item())

        train_loss = torch.tensor(weighted_loss_sum / weight_sum, dtype=torch.float32)

        model.eval()
        with torch.no_grad():
            val_logits = model(val_obs_tensor)
            val_loss = criterion(val_logits, val_labels_tensor).mean()
            predictions = masked_argmax(val_logits, val_masks_tensor)
            accuracy = (predictions == val_labels_tensor).float().mean()

        final_train_loss = float(train_loss.item())
        final_validation_loss = float(val_loss.item())
        validation_accuracy = float(accuracy.item())

    run_id = output_dir.name
    model_type = "mlp-" + "x".join([str(training_config["observationLength"]), *[str(value) for value in hidden_sizes], str(len(training_config["actionOrder"]))])
    metadata = {
        "runId": run_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "modelType": model_type,
        "inputSize": training_config["observationLength"],
        "hiddenSize": hidden_sizes[0],
        "hiddenSizes": hidden_sizes,
        "outputSize": len(training_config["actionOrder"]),
        "actionOrder": training_config["actionOrder"],
        "observationVersion": training_config["observationVersion"],
        "trainDatasetId": train_manifest["datasetId"],
        "supplementalDatasets": supplemental_metadata,
        "validationSeedSetId": validation_seed_set_id,
        "gateSeedSetId": gate_seed_set_id,
        "trainerStack": "python-pytorch",
    }

    torch.save(
        {
            "state_dict": model.state_dict(),
            "input_mean": input_mean.tolist(),
            "input_std": input_std.tolist(),
        },
        output_dir / "model.pt",
    )
    (output_dir / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    random_safe_eval = run_evaluation(
        output_dir,
        "random-safe",
        gate_seed_set_id,
        ARTIFACTS_DIR / "evals" / run_id / f"random-safe-{gate_seed_set_id}",
    )
    heuristic_eval = run_evaluation(
        output_dir,
        "heuristic",
        validation_seed_set_id,
        ARTIFACTS_DIR / "evals" / run_id / f"heuristic-{validation_seed_set_id}",
    )

    milestone_gate = {
        "validationSeedSetId": validation_seed_set_id,
        "gateSeedSetId": gate_seed_set_id,
        "minimumValidationActionAccuracy": training_config["milestoneGate"]["minimumValidationActionAccuracy"],
        "minimumRandomSafeWinRate": training_config["milestoneGate"]["minimumRandomSafeWinRate"],
        "passedValidationActionAccuracy": validation_accuracy >= training_config["milestoneGate"]["minimumValidationActionAccuracy"],
        "passedRandomSafeWinRate": random_safe_eval["metrics"]["winRate"] >= training_config["milestoneGate"]["minimumRandomSafeWinRate"],
    }
    milestone_gate["passed"] = (
        milestone_gate["passedValidationActionAccuracy"]
        and milestone_gate["passedRandomSafeWinRate"]
    )

    metrics = {
        "finalTrainLoss": final_train_loss,
        "finalValidationLoss": final_validation_loss,
        "validationActionAccuracy": validation_accuracy,
        "pythonStackVersions": ensure_python_stack_versions(),
        "trainingDataset": {
            "datasetId": train_manifest["datasetId"],
            "seedSetId": train_manifest["seedSetId"],
            "sampleCount": int(train_manifest["sampleCount"]),
        },
        "model": {
            "modelType": model_type,
            "hiddenSizes": hidden_sizes,
        },
        "supplementalDatasets": supplemental_metadata,
        "evaluationResultsAgainstRandomSafe": {
            "seedSetId": gate_seed_set_id,
            "metrics": random_safe_eval["metrics"],
        },
        "evaluationResultsAgainstHeuristic": {
            "seedSetId": validation_seed_set_id,
            "metrics": heuristic_eval["metrics"],
        },
        "milestoneGate": milestone_gate,
    }
    (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    print(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
