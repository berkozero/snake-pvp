from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional


class BridgeClient:
    def __init__(self, root_dir: Path) -> None:
        self._process = subprocess.Popen(
            ["bun", "tools/ai/scripts/bridge.ts"],
            cwd=root_dir,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        self._next_id = 0

    def close(self) -> None:
        if self._process.stdin:
            self._process.stdin.close()
        if self._process.stdout:
            self._process.stdout.close()
        self._process.wait(timeout=5)

    def reset(self, seed: int) -> Dict[str, Any]:
        response = self._request({"type": "reset", "seed": seed})
        if response["type"] != "reset_result":
            raise RuntimeError(response["error"])
        return response["result"]

    def step(self, actions: Dict[str, str]) -> Dict[str, Any]:
        response = self._request({"type": "step", "actions": actions})
        if response["type"] != "step_result":
            raise RuntimeError(response["error"])
        return response["result"]

    def capture_replay(self) -> Dict[str, Any]:
        response = self._request({"type": "capture_replay"})
        if response["type"] != "replay_result":
            raise RuntimeError(response["error"])
        return response["replay"]

    def get_observation(self, player_id: str) -> Dict[str, Any]:
        return self._request({"type": "get_observation", "playerId": player_id})

    def get_action_mask(self, player_id: str) -> Dict[str, Any]:
        return self._request({"type": "get_action_mask", "playerId": player_id})

    def _request(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self._process.stdin is None or self._process.stdout is None:
            raise RuntimeError("Bridge process streams are unavailable")
        request_id = f"req-{self._next_id}"
        self._next_id += 1
        self._process.stdin.write(json.dumps({"id": request_id, **payload}) + "\n")
        self._process.stdin.flush()
        while True:
            line = self._process.stdout.readline()
            if line == "":
                raise RuntimeError("Bridge process exited unexpectedly")
            response = json.loads(line)
            if response.get("id") == request_id:
                if response["type"] == "error":
                    raise RuntimeError(response["error"])
                return response
