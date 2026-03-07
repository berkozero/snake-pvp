from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

from rl_core import ActorCriticModel, export_policy_checkpoint, initialize_actor_critic_from_policy, load_policy_checkpoint, masked_greedy_actions, masked_sample
from rl_bridge import BridgeClient
from rl_train import enforce_resume_contract, load_config, load_resume_checkpoint, maybe_update_best_checkpoint, parse_runtime_checkpoint_state, restore_bridge_state, restore_rng_state, save_trainer_checkpoint


ROOT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = ROOT_DIR.parent.parent
INIT_CHECKPOINT_DIR = ROOT_DIR / ".local" / "artifacts" / "checkpoints" / "run-val-v1-large-h32x32-respawn8"


class RlTrainTests(unittest.TestCase):
    def test_imports_trunk_and_policy_weights_from_imitation_checkpoint(self) -> None:
        checkpoint = load_policy_checkpoint(INIT_CHECKPOINT_DIR)
        actor_critic = initialize_actor_critic_from_policy(checkpoint)
        state_dict = checkpoint.payload["state_dict"]
        self.assertTrue(torch.equal(actor_critic.trunk[0].weight, state_dict["0.weight"]))
        self.assertTrue(torch.equal(actor_critic.trunk[2].weight, state_dict["2.weight"]))
        self.assertTrue(torch.equal(actor_critic.policy_head.weight, state_dict["4.weight"]))

    def test_masked_sampling_never_emits_illegal_actions(self) -> None:
        logits = torch.tensor([[1.0, 2.0, 3.0, 4.0, 5.0]], dtype=torch.float32)
        mask = torch.tensor([[False, False, True, False, False]], dtype=torch.bool)
        for _ in range(50):
            actions, _, _ = masked_sample(logits, mask, generator=torch.Generator().manual_seed(7))
            self.assertEqual(int(actions.item()), 2)

    def test_masked_greedy_eval_never_emits_illegal_actions(self) -> None:
        logits = torch.tensor([[1.0, 20.0, 3.0, 4.0, 5.0]], dtype=torch.float32)
        mask = torch.tensor([[True, False, True, False, False]], dtype=torch.bool)
        self.assertEqual(int(masked_greedy_actions(logits, mask).item()), 2)

    def test_exported_policy_reloads_with_runtime_format(self) -> None:
        temp_dir = Path(tempfile.mkdtemp(prefix="snake-rl-export-"))
        self.addCleanup(lambda: shutil.rmtree(temp_dir, ignore_errors=True))
        checkpoint = load_policy_checkpoint(INIT_CHECKPOINT_DIR)
        actor_critic = initialize_actor_critic_from_policy(checkpoint)
        metadata = dict(checkpoint.metadata)
        metadata["sourceCheckpointDir"] = str(INIT_CHECKPOINT_DIR.resolve())
        export_policy_checkpoint(temp_dir, "rl-test", 3, actor_critic, metadata, checkpoint.input_mean, checkpoint.input_std)
        reloaded = load_policy_checkpoint(temp_dir)
        self.assertEqual(reloaded.metadata["checkpointOrigin"], "rl-ppo")
        self.assertEqual(reloaded.metadata["exportVersion"], "rl-policy-v1")
        self.assertEqual(sorted(reloaded.payload["state_dict"].keys()), ["0.bias", "0.weight", "2.bias", "2.weight", "4.bias", "4.weight"])
        self.assertEqual(reloaded.metadata["sourceCheckpointDir"], str(INIT_CHECKPOINT_DIR.resolve()))

    def test_trainer_checkpoint_resume_restores_model_optimizer_and_counters(self) -> None:
        temp_dir = Path(tempfile.mkdtemp(prefix="snake-rl-resume-"))
        self.addCleanup(lambda: shutil.rmtree(temp_dir, ignore_errors=True))
        config = load_config(ROOT_DIR / "configs" / "rl-config.json", "smoke", None)
        checkpoint = load_policy_checkpoint(INIT_CHECKPOINT_DIR)
        actor_critic = initialize_actor_critic_from_policy(checkpoint)
        optimizer = torch.optim.Adam(actor_critic.parameters(), lr=0.0003)
        generator = torch.Generator().manual_seed(123)
        np.random.seed(999)
        _ = np.random.rand()
        torch.manual_seed(321)
        _ = torch.rand(1)
        with torch.no_grad():
            actor_critic.value_head.bias.fill_(1.25)
        init_metadata = dict(checkpoint.metadata)
        init_metadata["sourceCheckpointDir"] = str(INIT_CHECKPOINT_DIR.resolve())
        save_trainer_checkpoint(
            temp_dir / "trainer_checkpoint.pt",
            actor_critic,
            optimizer,
            update_index=4,
            total_env_steps=128,
            completed_episodes=6,
            config=config,
            init_checkpoint_dir=INIT_CHECKPOINT_DIR,
            init_metadata=init_metadata,
            input_mean=checkpoint.input_mean,
            input_std=checkpoint.input_std,
            current_seed=456,
            next_observations={"p1": np.zeros(44, dtype=np.float32), "p2": np.ones(44, dtype=np.float32)},
            next_masks={"p1": np.array([True, False, True, False, True]), "p2": np.array([False, True, False, True, True])},
            pending_replay={"effectiveSeed": 456, "decisionSteps": [{"actions": {"p1": "up", "p2": "stay"}}]},
            episode_return_accumulator={"p1": 0.5, "p2": -0.25},
            torch_generator=generator,
        )

        reloaded_model = ActorCriticModel()
        reloaded_optimizer = torch.optim.Adam(reloaded_model.parameters(), lr=0.0003)
        payload = load_resume_checkpoint(temp_dir / "trainer_checkpoint.pt", reloaded_model, reloaded_optimizer)
        runtime_state = parse_runtime_checkpoint_state(payload)
        self.assertEqual(payload["update_index"], 4)
        self.assertEqual(payload["total_env_steps"], 128)
        self.assertEqual(payload["completed_episodes"], 6)
        self.assertTrue(torch.equal(reloaded_model.value_head.bias, actor_critic.value_head.bias))
        self.assertEqual(runtime_state.current_seed, 456)
        self.assertEqual(runtime_state.init_metadata["sourceCheckpointDir"], str(INIT_CHECKPOINT_DIR.resolve()))
        self.assertTrue(np.array_equal(runtime_state.next_observations["p2"], np.ones(44, dtype=np.float32)))
        self.assertEqual(runtime_state.episode_return_accumulator["p1"], 0.5)

        np.random.seed(1)
        torch.manual_seed(1)
        resumed_generator = torch.Generator().manual_seed(1)
        restore_rng_state(runtime_state, resumed_generator)
        self.assertEqual(np.random.get_state()[2], runtime_state.numpy_rng_state["pos"])
        self.assertTrue(torch.equal(torch.get_rng_state(), runtime_state.torch_rng_state))
        self.assertTrue(torch.equal(resumed_generator.get_state(), runtime_state.torch_generator_state))

    def test_resume_contract_rejects_mismatched_init_checkpoint(self) -> None:
        config = load_config(ROOT_DIR / "configs" / "rl-config.json", "smoke", None)
        checkpoint = load_policy_checkpoint(INIT_CHECKPOINT_DIR)
        init_metadata = dict(checkpoint.metadata)
        init_metadata["sourceCheckpointDir"] = str((INIT_CHECKPOINT_DIR.parent / "run-dev-v1-medium").resolve())
        runtime_state = parse_runtime_checkpoint_state(
            {
                "init_metadata": init_metadata,
                "input_mean": checkpoint.input_mean.tolist(),
                "input_std": checkpoint.input_std.tolist(),
                "current_seed": 17,
                "next_observations": {"p1": checkpoint.input_mean.tolist(), "p2": checkpoint.input_mean.tolist()},
                "next_masks": {"p1": [True, True, False, True, True], "p2": [True, True, False, True, True]},
                "pending_replay": {"effectiveSeed": 17, "decisionSteps": []},
                "episode_return_accumulator": {"p1": 0.0, "p2": 0.0},
                "torch_rng_state": torch.get_rng_state(),
                "torch_generator_state": torch.Generator().manual_seed(7).get_state(),
                "numpy_rng_state": {
                    "algorithm": np.random.get_state()[0],
                    "keys": np.random.get_state()[1].tolist(),
                    "pos": int(np.random.get_state()[2]),
                    "has_gauss": int(np.random.get_state()[3]),
                    "cached_gaussian": float(np.random.get_state()[4]),
                },
            }
        )
        with self.assertRaisesRegex(ValueError, "Resume init checkpoint mismatch"):
            enforce_resume_contract(config, runtime_state)

    def test_restore_bridge_state_reconstructs_pending_environment_state(self) -> None:
        bridge = BridgeClient(REPO_DIR)
        self.addCleanup(bridge.close)
        reset_result = bridge.reset(77)
        bridge.step({"p1": "up", "p2": "stay"})
        bridge.step({"p1": "up", "p2": "stay"})
        replay = bridge.capture_replay()
        runtime_state = parse_runtime_checkpoint_state(
            {
                "init_metadata": {"sourceCheckpointDir": str(INIT_CHECKPOINT_DIR.resolve())},
                "input_mean": [0.0] * 44,
                "input_std": [1.0] * 44,
                "current_seed": replay["effectiveSeed"],
                "next_observations": {
                    "p1": bridge.get_observation("p1")["observation"],
                    "p2": bridge.get_observation("p2")["observation"],
                },
                "next_masks": {
                    "p1": bridge.get_action_mask("p1")["actionMask"],
                    "p2": bridge.get_action_mask("p2")["actionMask"],
                },
                "pending_replay": replay,
                "episode_return_accumulator": {"p1": 0.0, "p2": 0.0},
                "torch_rng_state": torch.get_rng_state(),
                "torch_generator_state": torch.Generator().manual_seed(11).get_state(),
                "numpy_rng_state": {
                    "algorithm": np.random.get_state()[0],
                    "keys": np.random.get_state()[1].tolist(),
                    "pos": int(np.random.get_state()[2]),
                    "has_gauss": int(np.random.get_state()[3]),
                    "cached_gaussian": float(np.random.get_state()[4]),
                },
            }
        )

        restored_bridge = BridgeClient(REPO_DIR)
        self.addCleanup(restored_bridge.close)
        restored_observations, restored_masks = restore_bridge_state(restored_bridge, runtime_state)
        self.assertTrue(np.array_equal(restored_observations["p1"], runtime_state.next_observations["p1"]))
        self.assertTrue(np.array_equal(restored_masks["p2"], runtime_state.next_masks["p2"]))

    def test_best_checkpoint_tracking_copies_policy_and_writes_manifest(self) -> None:
        run_dir = Path(tempfile.mkdtemp(prefix="snake-rl-best-"))
        self.addCleanup(lambda: shutil.rmtree(run_dir, ignore_errors=True))
        policy_dir = run_dir / "policy"
        checkpoint = load_policy_checkpoint(INIT_CHECKPOINT_DIR)
        actor_critic = initialize_actor_critic_from_policy(checkpoint)
        metadata = dict(checkpoint.metadata)
        metadata["sourceCheckpointDir"] = str(INIT_CHECKPOINT_DIR.resolve())
        export_policy_checkpoint(policy_dir, "rl-best-test", 5, actor_critic, metadata, checkpoint.input_mean, checkpoint.input_std)

        manifest = maybe_update_best_checkpoint(
            run_dir=run_dir,
            run_id="rl-best-test",
            update_index=5,
            policy_dir=policy_dir,
            heuristic_eval={"seedSetId": "val-v1", "matchupTarget": "heuristic", "metrics": {"winRate": 0.625}},
            random_safe_eval={"metrics": {"winRate": 1.0}},
        )

        self.assertIsNotNone(manifest)
        best_policy_dir = run_dir / "best-policy"
        self.assertTrue((best_policy_dir / "model.pt").exists())
        self.assertTrue((run_dir / "best-checkpoint.json").exists())


if __name__ == "__main__":
    unittest.main()
