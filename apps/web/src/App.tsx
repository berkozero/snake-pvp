import { useEffect, useMemo, useRef, useState } from 'react';
import { BOARD_HEIGHT, BOARD_WIDTH, CELL_SIZE, formatTime, type Cell, type Direction, type PlayerId } from '@snake/game-core';
import {
  PROTOCOL_VERSION,
  ROOM_ID,
  type ActionRejectedMessage,
  type ClientMessage,
  type GameSnapshot,
  type JoinRejectedMessage,
  type ResultSnapshot,
  type RoomPhase,
  type RoomSnapshotMessage,
  type ServerMessage,
} from '@snake/game-core/protocol';
import SnakeWordmark from './SnakeWordmark';
import { getGameServerUrl } from './config';
import { getLobbySlotColors, getMatchPlayerColors, getRespawnPreviewColors } from './playerColors';

type ClientPayload = ClientMessage extends infer T
  ? T extends ClientMessage
    ? Omit<T, 'v' | 'roomId' | 'roundId'>
    : never
  : never;

type RenderFrame = {
  roundId: string | null;
  phase: RoomPhase;
  tickSeq: number;
  game: GameSnapshot | null;
};

type RenderSegment = {
  x: number;
  y: number;
};

type ViewerUiState = {
  isWatcher: boolean;
  isAiOnlyRoom: boolean;
  isLockedViewer: boolean;
  showLobbyOverlay: boolean;
  showPlayerClaims: boolean;
  canClaim: boolean;
  canStart: boolean;
};

type PlayerSlotCardProps = {
  slot: PlayerId;
  slotName: string;
  slotStatus: string;
  textColor: string;
  statusColor: string;
  controller: RoomSnapshotMessage['slots'][PlayerId]['controller'];
  claimed: boolean;
  connected: boolean;
  inputValue: string;
  canClaim: boolean;
  canAddAi: boolean;
  canRemoveAi: boolean;
  showPlayerClaims: boolean;
  isOwner: boolean;
  onInputChange: (value: string) => void;
  onClaim: () => void;
  onLeave: () => void;
  onAddAi: () => void;
  onRemoveAi: () => void;
};

const CANVAS_WIDTH = BOARD_WIDTH * CELL_SIZE;
const CANVAS_HEIGHT = BOARD_HEIGHT * CELL_SIZE;
const RESUME_TOKEN_KEY = 'snake-pvp-resume-token';
const GAME_SERVER_URL = getGameServerUrl();
const EMPTY_SNAPSHOT: RoomSnapshotMessage = {
  v: PROTOCOL_VERSION,
  type: 'room_snapshot',
  roomId: ROOM_ID,
  roundId: null,
  serverTime: 0,
  phase: 'empty',
  tickSeq: 0,
  yourSlot: null,
  resumeToken: null,
  slots: {
    p1: { claimed: false, name: null, connected: false, controller: 'none' },
    p2: { claimed: false, name: null, connected: false, controller: 'none' },
  },
  game: null,
  result: null,
};
const DIRECTION_KEYS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up',
  ArrowLeft: 'left',
  ArrowDown: 'down',
  ArrowRight: 'right',
};
declare global {
  interface Window {
    __SNAKE_PVP_STATE__?: RoomSnapshotMessage;
    __SNAKE_PVP_TEST_API__?: {
      snapshot: () => RoomSnapshotMessage;
    };
  }
}

function nextRequestId(): string {
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

function getRenderFrame(snapshot: RoomSnapshotMessage): RenderFrame {
  return {
    roundId: snapshot.roundId,
    phase: snapshot.phase,
    tickSeq: snapshot.tickSeq,
    game: snapshot.game,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isSafeInterpolatedMove(previous: Cell, current: Cell): boolean {
  return Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y) === 1;
}

function canInterpolatePlayer(previousFrame: RenderFrame | null, currentFrame: RenderFrame | null, playerId: PlayerId): boolean {
  if (!previousFrame || !currentFrame || !previousFrame.game || !currentFrame.game) {
    return false;
  }
  if (previousFrame.roundId !== currentFrame.roundId) {
    return false;
  }
  if (previousFrame.phase !== 'playing' || currentFrame.phase !== 'playing') {
    return false;
  }
  if (currentFrame.tickSeq <= previousFrame.tickSeq) {
    return false;
  }

  const previousPlayer = previousFrame.game.players[playerId];
  const currentPlayer = currentFrame.game.players[playerId];
  if (!previousPlayer.alive || !currentPlayer.alive) {
    return false;
  }
  if (previousPlayer.segments.length !== currentPlayer.segments.length) {
    return false;
  }

  const previousHead = previousPlayer.segments[0];
  const currentHead = currentPlayer.segments[0];
  if (!previousHead || !currentHead) {
    return false;
  }

  return isSafeInterpolatedMove(previousHead, currentHead);
}

function getRenderedSegments(
  previousFrame: RenderFrame | null,
  currentFrame: RenderFrame | null,
  playerId: PlayerId,
  interpolationAlpha: number,
): RenderSegment[] {
  const currentPlayer = currentFrame?.game?.players[playerId];
  if (!currentPlayer) {
    return [];
  }
  if (!canInterpolatePlayer(previousFrame, currentFrame, playerId)) {
    return currentPlayer.segments;
  }

  const previousSegments = previousFrame!.game!.players[playerId].segments;
  return currentPlayer.segments.map((segment, index) => {
    const previous = previousSegments[index];
    return {
      x: previous.x + (segment.x - previous.x) * interpolationAlpha,
      y: previous.y + (segment.y - previous.y) * interpolationAlpha,
    };
  });
}

function drawArena(
  ctx: CanvasRenderingContext2D,
  currentFrame: RenderFrame | null,
  previousFrame: RenderFrame | null,
  interpolationAlpha: number,
  yourSlot: PlayerId | null,
): void {
  const currentGame = currentFrame?.game ?? null;
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const grid = ctx.createLinearGradient(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  grid.addColorStop(0, 'rgba(52, 52, 58, 0.14)');
  grid.addColorStop(0.55, 'rgba(18, 18, 24, 0.08)');
  grid.addColorStop(1, 'rgba(6, 6, 10, 0.03)');
  ctx.fillStyle = '#050507';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = grid;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const vignette = ctx.createRadialGradient(
    CANVAS_WIDTH / 2,
    CANVAS_HEIGHT / 2,
    CANVAS_WIDTH * 0.1,
    CANVAS_WIDTH / 2,
    CANVAS_HEIGHT / 2,
    CANVAS_WIDTH * 0.75,
  );
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.38)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  ctx.strokeStyle = 'rgba(205, 205, 218, 0.028)';
  ctx.lineWidth = 1;
  for (let x = CELL_SIZE; x < CANVAS_WIDTH; x += CELL_SIZE) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, CANVAS_HEIGHT);
    ctx.stroke();
  }
  for (let y = CELL_SIZE; y < CANVAS_HEIGHT; y += CELL_SIZE) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(CANVAS_WIDTH, y + 0.5);
    ctx.stroke();
  }

  ctx.save();
  ctx.strokeStyle = 'rgba(224, 224, 232, 0.11)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, CANVAS_WIDTH - 1, CANVAS_HEIGHT - 1);
  ctx.strokeStyle = 'rgba(96, 96, 108, 0.18)';
  ctx.strokeRect(6.5, 6.5, CANVAS_WIDTH - 13, CANVAS_HEIGHT - 13);
  ctx.restore();

  if (!currentGame) {
    return;
  }

  const foodX = currentGame.food.x * CELL_SIZE + CELL_SIZE / 2;
  const foodY = currentGame.food.y * CELL_SIZE + CELL_SIZE / 2;
  ctx.save();
  ctx.shadowBlur = 22;
  ctx.shadowColor = 'rgba(255, 158, 59, 0.75)';
  ctx.fillStyle = '#ff9e3b';
  ctx.beginPath();
  ctx.arc(foodX, foodY, CELL_SIZE * 0.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffd8ae';
  ctx.beginPath();
  ctx.arc(foodX - 2, foodY - 2, CELL_SIZE * 0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  (['p1', 'p2'] as PlayerId[]).forEach((playerId) => {
    const segments = getRenderedSegments(previousFrame, currentFrame, playerId, interpolationAlpha);
    const colors = getMatchPlayerColors(playerId, yourSlot);
    segments.forEach((segment, index) => {
      const x = segment.x * CELL_SIZE;
      const y = segment.y * CELL_SIZE;
      const inset = index === 0 ? 2 : 4;

      ctx.save();
      ctx.fillStyle = colors.fill;
      ctx.shadowBlur = index === 0 ? 20 : 12;
      ctx.shadowColor = colors.glow;
      ctx.fillRect(x + inset, y + inset, CELL_SIZE - inset * 2, CELL_SIZE - inset * 2);
      if (index === 0) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + inset + 1, y + inset + 1, CELL_SIZE - inset * 2 - 2, CELL_SIZE - inset * 2 - 2);
      }
      ctx.restore();
    });
  });

}

function getWinnerLabel(result: ResultSnapshot | null, snapshot: RoomSnapshotMessage): string {
  if (!result) {
    return 'Match Over';
  }

  if (result.winner === 'draw') {
    return 'Draw Game';
  }

  const winnerName = snapshot.slots[result.winner].name ?? result.winner.toUpperCase();
  if (result.reason === 'forfeit') {
    return `${winnerName} Wins by Forfeit`;
  }

  return `${winnerName} Wins`;
}

export function getViewerUiState(snapshot: RoomSnapshotMessage, connected: boolean): ViewerUiState {
  const isWatcher = snapshot.yourSlot === null;
  const isAiOnlyRoom =
    snapshot.slots.p1.controller === 'ai' &&
    snapshot.slots.p2.controller === 'ai';
  const isLockedViewer =
    isWatcher &&
    snapshot.slots.p1.claimed &&
    snapshot.slots.p2.claimed &&
    !isAiOnlyRoom &&
    (
      snapshot.phase === 'countdown' ||
      snapshot.phase === 'playing' ||
      snapshot.phase === 'ready'
    );
  return {
    isWatcher,
    isAiOnlyRoom,
    isLockedViewer,
    showLobbyOverlay:
      snapshot.phase === 'empty' ||
      snapshot.phase === 'waiting' ||
      (snapshot.phase === 'ready' && !isLockedViewer),
    showPlayerClaims: !isLockedViewer && (snapshot.phase === 'empty' || snapshot.phase === 'waiting'),
    canClaim: connected && isWatcher && (snapshot.phase === 'empty' || snapshot.phase === 'waiting'),
    canStart: connected && snapshot.phase === 'ready' && (!isWatcher || isAiOnlyRoom),
  };
}

export function getStatusMessage(snapshot: RoomSnapshotMessage): string {
  const { phase, yourSlot } = snapshot;
  const { isAiOnlyRoom } = getViewerUiState(snapshot, true);

  if (phase === 'empty') {
    return 'Claim a slot to open the room.';
  }
  if (phase === 'waiting') {
    return yourSlot ? 'Waiting for the other side to be filled.' : 'One side is claimed. Join the other side or add AI.';
  }
  if (phase === 'ready') {
    if (yourSlot) {
      return 'Both sides are ready. Either human can start.';
    }
    return isAiOnlyRoom ? 'AI match ready. Start to watch.' : 'Room is full and ready.';
  }
  if (phase === 'countdown') {
    if (yourSlot) {
      return 'Countdown live. Pre-turns are accepted now.';
    }
    return isAiOnlyRoom ? 'Watching AI match. Countdown live.' : 'Match starting.';
  }
  if (phase === 'playing') {
    if (yourSlot) {
      return 'Authoritative online match in progress.';
    }
    return isAiOnlyRoom ? 'Watching AI match.' : 'Match in progress.';
  }

  return 'Result locked in. Room resets automatically.';
}

function getPlayerName(snapshot: RoomSnapshotMessage, slot: PlayerId): string {
  return snapshot.slots[slot].name ?? slot.toUpperCase();
}

function normalizeKey(key: string): string {
  if (key.startsWith('Arrow')) {
    return key;
  }

  return key.toLowerCase();
}

function cellOrDash(cell: Cell | null): string {
  if (!cell) {
    return '--';
  }

  return `${cell.x},${cell.y}`;
}

function getSlotStatus(snapshot: RoomSnapshotMessage, slot: PlayerId): string {
  const state = snapshot.slots[slot];
  if (!state.claimed) {
    return '';
  }
  return state.connected ? 'Connected' : 'Reserved';
}

function getSlotStatusColor(snapshot: RoomSnapshotMessage, slot: PlayerId, fallbackColor: string): string {
  const state = snapshot.slots[slot];
  if (state.claimed && state.connected) {
    return '#7cff7a';
  }

  return fallbackColor;
}

function getPreviewRotation(direction: GameSnapshot['players'][PlayerId]['direction']): number {
  if (direction === 'up') {
    return 0;
  }
  if (direction === 'right') {
    return 90;
  }
  if (direction === 'down') {
    return 180;
  }
  return 270;
}

function PlayerSlotCard({
  slot,
  slotName,
  slotStatus,
  textColor,
  statusColor,
  controller,
  claimed,
  connected,
  inputValue,
  canClaim,
  canAddAi,
  canRemoveAi,
  showPlayerClaims,
  isOwner,
  onInputChange,
  onClaim,
  onLeave,
  onAddAi,
  onRemoveAi,
}: PlayerSlotCardProps) {
  return (
    <article className="player-slot-card" data-testid={`slot-${slot}`}>
      <div className="slot-row">
        <strong style={{ color: textColor }}>{slotName}</strong>
        <span style={{ color: statusColor }}>{slotStatus}</span>
        {!claimed ? (
          <input
            className="slot-input"
            data-testid={`name-input-${slot}`}
            value={inputValue}
            maxLength={16}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder="Enter handle"
            disabled={!canClaim || !showPlayerClaims}
          />
        ) : null}
      </div>
      {showPlayerClaims && !isOwner && controller !== 'ai' ? (
        <button
          data-testid={`claim-${slot}`}
          onClick={onClaim}
          disabled={!canClaim || (claimed && connected)}
        >
          {`Claim ${slot.toUpperCase()}`}
        </button>
      ) : null}
      {isOwner ? (
        <button
          data-testid="leave-slot"
          className="secondary"
          onClick={onLeave}
          disabled={!connected}
        >
          Leave Slot
        </button>
      ) : null}
      {!claimed ? (
        <button
          type="button"
          data-testid={`add-ai-${slot}`}
          className="secondary"
          onClick={onAddAi}
          disabled={!canAddAi}
        >
          Add AI
        </button>
      ) : null}
      {controller === 'ai' ? (
        <button
          type="button"
          data-testid={`remove-ai-${slot}`}
          className="secondary"
          onClick={onRemoveAi}
          disabled={!canRemoveAi}
        >
          Remove AI
        </button>
      ) : null}
    </article>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<RoomSnapshotMessage>(EMPTY_SNAPSHOT);
  const [p1Name, setP1Name] = useState('');
  const [p2Name, setP2Name] = useState('');
  const [rulesExpanded, setRulesExpanded] = useState(false);
  const [message, setMessage] = useState('Connect to the server to claim a slot.');
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const inputSeqRef = useRef(0);
  const snapshotRef = useRef(snapshot);
  const resumeTokenRef = useRef<string | null>(window.localStorage.getItem(RESUME_TOKEN_KEY));
  const prevFrameRef = useRef<RenderFrame | null>(null);
  const currFrameRef = useRef<RenderFrame>(getRenderFrame(EMPTY_SNAPSHOT));
  const snapshotReceivedAtRef = useRef(performance.now());
  const snapshotIntervalRef = useRef(100);
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
    window.__SNAKE_PVP_STATE__ = snapshot;
  }, [snapshot]);

  useEffect(() => {
    window.__SNAKE_PVP_TEST_API__ = {
      snapshot: () => snapshotRef.current,
    };

    return () => {
      delete window.__SNAKE_PVP_STATE__;
      delete window.__SNAKE_PVP_TEST_API__;
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) {
        return;
      }

      const socket = new WebSocket(GAME_SERVER_URL);
      socketRef.current = socket;
      setReconnecting(true);

      socket.addEventListener('open', () => {
        setConnected(true);
        setReconnecting(false);
        setMessage(resumeTokenRef.current ? 'Connected. Restoring your slot.' : 'Connected. Claim a slot to play.');

        if (resumeTokenRef.current) {
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'resume_session',
              roomId: ROOM_ID,
              roundId: snapshotRef.current.roundId,
              requestId: nextRequestId(),
              resumeToken: resumeTokenRef.current,
            } satisfies ClientMessage),
          );
        }

        if (pingTimerRef.current !== null) {
          window.clearInterval(pingTimerRef.current);
        }

        pingTimerRef.current = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            const payload: ClientMessage = {
              v: PROTOCOL_VERSION,
              type: 'ping',
              roomId: ROOM_ID,
              roundId: snapshotRef.current.roundId,
              clientTime: Date.now(),
            };
            socket.send(JSON.stringify(payload));
          }
        }, 2_000);
      });

      socket.addEventListener('message', (event) => {
        const incoming = JSON.parse(String(event.data)) as ServerMessage;

        if (incoming.type === 'room_snapshot') {
          const receivedAt = performance.now();
          prevFrameRef.current = currFrameRef.current;
          currFrameRef.current = getRenderFrame(incoming);
          snapshotIntervalRef.current = Math.max(1, receivedAt - snapshotReceivedAtRef.current);
          snapshotReceivedAtRef.current = receivedAt;
          resumeTokenRef.current = incoming.resumeToken;
          if (incoming.resumeToken) {
            window.localStorage.setItem(RESUME_TOKEN_KEY, incoming.resumeToken);
          } else {
            window.localStorage.removeItem(RESUME_TOKEN_KEY);
          }
          if (incoming.yourSlot === null) {
            inputSeqRef.current = 0;
          }
          setSnapshot(incoming);
          setMessage(getStatusMessage(incoming));
          return;
        }

        if (incoming.type === 'join_rejected') {
          const reasons: Record<JoinRejectedMessage['reason'], string> = {
            slot_taken: 'That slot is already claimed.',
            duplicate_name: 'Names must be unique within the room.',
            invalid_name: 'Use a non-empty name up to 16 characters.',
            room_locked: 'The room is locked until the current match resets.',
            already_claimed: 'This client already owns a slot.',
            slot_reserved: 'Slot reserved, try again in a few seconds.',
          };
          setMessage(reasons[incoming.reason]);
          return;
        }

        if (incoming.type === 'action_rejected') {
          const reasons: Record<ActionRejectedMessage['reason'], string> = {
            not_owner: 'That slot can no longer be restored.',
            invalid_phase: 'That action is not allowed right now.',
            stale_input: 'That input arrived too late.',
            invalid_direction: 'That turn was not valid.',
          };
          if (incoming.reason === 'not_owner' && resumeTokenRef.current && snapshotRef.current.yourSlot === null) {
            resumeTokenRef.current = null;
            window.localStorage.removeItem(RESUME_TOKEN_KEY);
          }
          setMessage(reasons[incoming.reason]);
          return;
        }
      });

      socket.addEventListener('close', () => {
        if (disposed) {
          return;
        }

        setConnected(false);
        setReconnecting(true);
        setMessage(resumeTokenRef.current ? 'Disconnected. Trying to restore your slot.' : 'Disconnected. Reconnecting as a viewer.');

        if (pingTimerRef.current !== null) {
          window.clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }

        reconnectTimerRef.current = window.setTimeout(connect, 1_500);
      });

      socket.addEventListener('error', () => {
        setMessage(`Cannot reach game server at ${GAME_SERVER_URL}.`);
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (pingTimerRef.current !== null) {
        window.clearInterval(pingTimerRef.current);
      }
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = snapshotRef.current;
      if (!current.yourSlot) {
        return;
      }

      if (event.key === 'Enter' && current.phase === 'ready') {
        event.preventDefault();
        sendMessage({
          type: 'start_match',
          requestId: nextRequestId(),
        });
        return;
      }

      const direction = DIRECTION_KEYS[normalizeKey(event.key)];
      if (!direction) {
        return;
      }

      event.preventDefault();
      sendDirection(direction);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const sendMessage = (message: ClientPayload) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    socketRef.current.send(
      JSON.stringify({
        ...message,
        v: PROTOCOL_VERSION,
        roomId: ROOM_ID,
        roundId: snapshotRef.current.roundId,
      }),
    );
  };

  const sendDirection = (direction: Direction) => {
    if (!snapshotRef.current.yourSlot) {
      return;
    }

    inputSeqRef.current += 1;
    sendMessage({
      type: 'input_direction',
      direction,
      inputSeq: inputSeqRef.current,
      clientTime: Date.now(),
    });
  };

  const sendStartMatch = () => {
    sendMessage({ type: 'start_match', requestId: nextRequestId() });
  };

  const setAiSlot = (slot: PlayerId, enabled: boolean) => {
    sendMessage({ type: 'set_ai_slot', requestId: nextRequestId(), slot, enabled });
  };

  const leaveCurrentSlot = () => {
    window.localStorage.removeItem(RESUME_TOKEN_KEY);
    resumeTokenRef.current = null;
    sendMessage({ type: 'leave_slot', requestId: nextRequestId() });
  };

  const countdownLabel = useMemo(() => {
    if (snapshot.phase !== 'countdown' || !snapshot.game) {
      return null;
    }
    return `${Math.max(1, Math.ceil(snapshot.game.countdownMs / 800))}`;
  }, [snapshot]);

  const viewerUi = getViewerUiState(snapshot, connected);
  const { isLockedViewer, showLobbyOverlay, showPlayerClaims, canClaim, canStart } = viewerUi;
  const canManageAi = connected && (snapshot.phase === 'empty' || snapshot.phase === 'waiting' || snapshot.phase === 'ready');
  const heads = snapshot.game
    ? {
        p1: snapshot.game.players.p1.segments[0] ?? null,
        p2: snapshot.game.players.p2.segments[0] ?? null,
      }
    : { p1: null, p2: null };
  const p1MatchColors = getMatchPlayerColors('p1', snapshot.yourSlot);
  const p2MatchColors = getMatchPlayerColors('p2', snapshot.yourSlot);
  const p1LobbyColors = getLobbySlotColors('p1', snapshot.yourSlot);
  const p2LobbyColors = getLobbySlotColors('p2', snapshot.yourSlot);
  const shouldAnimateArena = !showLobbyOverlay;
  const showTouchControls = snapshot.yourSlot !== null && (snapshot.phase === 'countdown' || snapshot.phase === 'playing');

  useEffect(() => {
    if (!shouldAnimateArena) {
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const render = () => {
      const currentFrame = currFrameRef.current;
      const previousFrame = prevFrameRef.current;
      const interpolationAlpha = clamp01(
        (performance.now() - snapshotReceivedAtRef.current) / snapshotIntervalRef.current,
      );
      drawArena(context, currentFrame, previousFrame, interpolationAlpha, snapshotRef.current.yourSlot);
      rafIdRef.current = window.requestAnimationFrame(render);
    };

    rafIdRef.current = window.requestAnimationFrame(render);

    return () => {
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [shouldAnimateArena]);

  return (
    <main className="shell" data-phase={snapshot.phase}>
      {!showLobbyOverlay ? (
        <section className="hud-card" data-testid="hud-card">
          <div className="hud-brand">
            <SnakeWordmark className="hud-wordmark" />
          </div>
          <div className="status-row">
            <div data-testid="connection-card">
              <span>Server</span>
              <strong>{connected ? 'Online' : reconnecting ? 'Reconnecting' : 'Offline'}</strong>
            </div>
            <div data-testid="timer-card">
              <span>Timer</span>
              <strong data-testid="timer-value">{formatTime(snapshot.game?.remainingMs ?? 0)}</strong>
            </div>
            <div data-testid="p1-score-card">
              <span style={{ color: p1MatchColors.text }}>{getPlayerName(snapshot, 'p1')}</span>
              <strong data-testid="p1-score" style={{ color: p1MatchColors.text }}>
                {snapshot.game?.players.p1.respawnRemainingMs
                  ? `Respawn ${Math.ceil(snapshot.game.players.p1.respawnRemainingMs / 1000)}`
                  : snapshot.game?.players.p1.score ?? 0}
              </strong>
            </div>
            <div data-testid="p2-score-card">
              <span style={{ color: p2MatchColors.text }}>{getPlayerName(snapshot, 'p2')}</span>
              <strong data-testid="p2-score" style={{ color: p2MatchColors.text }}>
                {snapshot.game?.players.p2.respawnRemainingMs
                  ? `Respawn ${Math.ceil(snapshot.game.players.p2.respawnRemainingMs / 1000)}`
                  : snapshot.game?.players.p2.score ?? 0}
              </strong>
            </div>
          </div>
        </section>
      ) : null}

      {showLobbyOverlay ? (
        <section className="menu-hero" data-testid="lobby-overlay">
          <SnakeWordmark className="menu-wordmark" />
          <p className="menu-tagline">Ninety seconds. Outgrow or outcut.</p>
          <button
            data-testid="start-match"
            className="start-button"
            onClick={sendStartMatch}
            disabled={!canStart}
          >
            Start Match
          </button>
        </section>
      ) : null}

      <section className="arena-card" style={showLobbyOverlay ? { display: 'none' } : undefined}>
        <div className="arena-stage">
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="arena"
            data-testid="game-canvas"
          />
          {snapshot.game ? (
            <div className="respawn-preview-layer" aria-hidden="true">
              {(['p1', 'p2'] as PlayerId[]).map((playerId) => {
                const player = snapshot.game?.players[playerId];
                if (!player || player.alive || player.respawnRemainingMs <= 0 || !player.respawnPreview) {
                  return null;
                }

                const colors = getRespawnPreviewColors(playerId, snapshot.yourSlot);
                return (
                  <div
                    key={playerId}
                    className={`respawn-preview-marker ${playerId}`}
                    data-testid={`${playerId}-respawn-preview`}
                    style={{
                      left: `${((player.respawnPreview.head.x + 0.5) / BOARD_WIDTH) * 100}%`,
                      top: `${((player.respawnPreview.head.y + 0.5) / BOARD_HEIGHT) * 100}%`,
                      ['--preview-fill' as string]: colors.fill,
                      ['--preview-glow' as string]: colors.glow,
                      ['--preview-rotation' as string]: `${getPreviewRotation(player.respawnPreview.direction)}deg`,
                    }}
                  >
                    <span className="respawn-preview-cell" />
                    <span className="respawn-preview-head" />
                    <span className="respawn-preview-arrow" />
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {snapshot.phase === 'countdown' ? (
          <div className="overlay slim" data-testid="countdown-overlay">
            <p className="eyebrow">Get ready</p>
            <h2 data-testid="countdown-value">{countdownLabel}</h2>
            <p className="status-copy">Pre-turns are live. Movement starts when the server flips to play.</p>
          </div>
        ) : null}

        {isLockedViewer ? (
          <div className="overlay slim" data-testid="viewer-overlay">
            <p className="eyebrow">Room Locked</p>
            <h2>{snapshot.phase === 'finished' ? 'Match Resetting' : 'Room Full'}</h2>
            <p className="status-copy">{message}</p>
          </div>
        ) : null}

        {snapshot.phase === 'finished' ? (
          <div className="overlay" data-testid="finished-overlay">
            <p className="eyebrow">{snapshot.result?.reason === 'forfeit' ? 'Forfeit' : 'Time Up'}</p>
            <h2 data-testid="winner-label">{getWinnerLabel(snapshot.result, snapshot)}</h2>
            <div className="controls-grid score-grid">
              <p style={{ color: p1MatchColors.text }}><span style={{ color: p1MatchColors.text }}>{getPlayerName(snapshot, 'p1')}</span> {snapshot.game?.players.p1.score ?? 0}</p>
              <p style={{ color: p2MatchColors.text }}><span style={{ color: p2MatchColors.text }}>{getPlayerName(snapshot, 'p2')}</span> {snapshot.game?.players.p2.score ?? 0}</p>
              <p><span>P1 Head</span> {cellOrDash(heads.p1)}</p>
              <p><span>P2 Head</span> {cellOrDash(heads.p2)}</p>
            </div>
          </div>
        ) : null}
      </section>

      {!showLobbyOverlay ? (
        <section className="touch-controls-card" data-testid="touch-controls-card">
          {showTouchControls ? (
            <div className="touch-controls-pad" data-testid="touch-controls-pad">
              <button
                type="button"
                className="touch-control up"
                data-testid="touch-up"
                aria-label="Move up"
                onClick={() => sendDirection('up')}
              >
                Up
              </button>
              <button
                type="button"
                className="touch-control left"
                data-testid="touch-left"
                aria-label="Move left"
                onClick={() => sendDirection('left')}
              >
                Left
              </button>
              <button
                type="button"
                className="touch-control right"
                data-testid="touch-right"
                aria-label="Move right"
                onClick={() => sendDirection('right')}
              >
                Right
              </button>
              <button
                type="button"
                className="touch-control down"
                data-testid="touch-down"
                aria-label="Move down"
                onClick={() => sendDirection('down')}
              >
                Down
              </button>
            </div>
          ) : (
            <p className="touch-controls-idle" data-testid="touch-controls-idle">
              Touch controls appear for active players during countdown and live play.
            </p>
          )}
        </section>
      ) : null}

      <section className="players-card" data-testid="players-card" style={!showLobbyOverlay ? { display: 'none' } : undefined}>
        <div className="players-title">
          <div
            className={`health-indicator ${connected ? 'is-good' : 'is-bad'}`}
            data-testid="health-indicator"
            aria-live="polite"
            aria-label={connected ? 'Connection healthy' : reconnecting ? 'Connection problem' : 'Server problem'}
          >
            <span className="health-dot" aria-hidden="true" />
          </div>
          <strong>Claim your side</strong>
        </div>
        <div className="players-grid">
          <PlayerSlotCard
            slot="p1"
            slotName={getPlayerName(snapshot, 'p1')}
            slotStatus={getSlotStatus(snapshot, 'p1')}
            textColor={p1LobbyColors.text}
            statusColor={getSlotStatusColor(snapshot, 'p1', p1LobbyColors.status)}
            controller={snapshot.slots.p1.controller}
            claimed={snapshot.slots.p1.claimed}
            connected={snapshot.slots.p1.connected}
            inputValue={p1Name}
            canClaim={canClaim}
            canAddAi={canManageAi && !snapshot.slots.p1.claimed}
            canRemoveAi={canManageAi && snapshot.slots.p1.controller === 'ai'}
            showPlayerClaims={showPlayerClaims}
            isOwner={snapshot.yourSlot === 'p1'}
            onInputChange={setP1Name}
            onClaim={() => sendMessage({ type: 'join_slot', requestId: nextRequestId(), slot: 'p1', name: p1Name })}
            onLeave={leaveCurrentSlot}
            onAddAi={() => setAiSlot('p1', true)}
            onRemoveAi={() => setAiSlot('p1', false)}
          />
          <PlayerSlotCard
            slot="p2"
            slotName={getPlayerName(snapshot, 'p2')}
            slotStatus={getSlotStatus(snapshot, 'p2')}
            textColor={p2LobbyColors.text}
            statusColor={getSlotStatusColor(snapshot, 'p2', p2LobbyColors.status)}
            controller={snapshot.slots.p2.controller}
            claimed={snapshot.slots.p2.claimed}
            connected={snapshot.slots.p2.connected}
            inputValue={p2Name}
            canClaim={canClaim}
            canAddAi={canManageAi && !snapshot.slots.p2.claimed}
            canRemoveAi={canManageAi && snapshot.slots.p2.controller === 'ai'}
            showPlayerClaims={showPlayerClaims}
            isOwner={snapshot.yourSlot === 'p2'}
            onInputChange={setP2Name}
            onClaim={() => sendMessage({ type: 'join_slot', requestId: nextRequestId(), slot: 'p2', name: p2Name })}
            onLeave={leaveCurrentSlot}
            onAddAi={() => setAiSlot('p2', true)}
            onRemoveAi={() => setAiSlot('p2', false)}
          />
        </div>
        <section className="how-to-play how-to-play-panel" aria-label="How to play">
          <h3>How to Play</h3>
          <div className="how-to-play-summary" data-testid="rules-summary">
            <p>Claim a side, survive collisions, cut bodies, and finish the 90-second round with the best score.</p>
            <button
              type="button"
              className="secondary rules-toggle"
              data-testid="rules-toggle"
              aria-expanded={rulesExpanded}
              onClick={() => setRulesExpanded((expanded) => !expanded)}
            >
              {rulesExpanded ? 'Hide Full Rules' : 'Show Full Rules'}
            </button>
          </div>
          <div className={`how-to-play-groups ${rulesExpanded ? 'is-expanded' : ''}`} data-testid="rules-groups">
            <section className="how-to-play-group" aria-label="Get in">
              <p className="how-to-play-group-label">Get In</p>
              <ul className="how-to-play-list">
                <li>
                  <strong className="how-to-play-marker">[+]</strong>
                  <div className="how-to-play-copy">
                    <span className="how-to-play-item-title">Claim a Side</span>
                    <span className="how-to-play-item-description">Choose P1 or P2, enter your name, and lock in your slot.</span>
                  </div>
                </li>
                <li>
                  <strong className="how-to-play-marker">[+]</strong>
                  <div className="how-to-play-copy">
                    <span className="how-to-play-item-title">Start the Match</span>
                    <span className="how-to-play-item-description">When both players are ready, press Enter or use the Start button.</span>
                  </div>
                </li>
              </ul>
            </section>
            <section className="how-to-play-group" aria-label="Grow">
              <p className="how-to-play-group-label">Grow</p>
              <ul className="how-to-play-list">
                <li>
                  <strong className="how-to-play-marker">[+]</strong>
                  <div className="how-to-play-copy">
                    <span className="how-to-play-item-title">Eat to Grow</span>
                    <span className="how-to-play-item-description">Collect food to score points and grow longer before the 90-second match ends.</span>
                  </div>
                </li>
              </ul>
            </section>
            <section className="how-to-play-group" aria-label="Combat">
              <p className="how-to-play-group-label">Combat</p>
              <ul className="how-to-play-list">
                <li>
                  <strong className="how-to-play-marker">[+]</strong>
                  <div className="how-to-play-copy">
                    <span className="how-to-play-item-title">Cut the Body</span>
                    <span className="how-to-play-item-description">Hit the enemy body to cut it shorter.</span>
                  </div>
                </li>
                <li>
                  <strong className="how-to-play-marker">[+]</strong>
                  <div className="how-to-play-copy">
                    <span className="how-to-play-item-title">Hit the Neck</span>
                    <span className="how-to-play-item-description">Hit the enemy neck to kill that snake.</span>
                  </div>
                </li>
                <li>
                  <strong className="how-to-play-marker">[+]</strong>
                  <div className="how-to-play-copy">
                    <span className="how-to-play-item-title">Head-to-Head</span>
                    <span className="how-to-play-item-description">In a head-to-head, the longer snake survives. If both are the same length, both snakes die.</span>
                  </div>
                </li>
              </ul>
            </section>
            <section className="how-to-play-group" aria-label="Respawn">
              <p className="how-to-play-group-label">Respawn</p>
              <ul className="how-to-play-list">
                <li>
                  <strong className="how-to-play-marker">[+]</strong>
                  <div className="how-to-play-copy">
                    <span className="how-to-play-item-title">Hit a Wall</span>
                    <span className="how-to-play-item-description">Running into a wall kills your snake.</span>
                  </div>
                </li>
                <li>
                  <strong className="how-to-play-marker">[+]</strong>
                  <div className="how-to-play-copy">
                    <span className="how-to-play-item-title">Hit Yourself</span>
                    <span className="how-to-play-item-description">Running into your own body kills your snake.</span>
                  </div>
                </li>
                <li>
                  <strong className="how-to-play-marker">[+]</strong>
                  <div className="how-to-play-copy">
                    <span className="how-to-play-item-title">Come Back In</span>
                    <span className="how-to-play-item-description">After 2 seconds, your snake respawns and keeps playing.</span>
                  </div>
                </li>
              </ul>
            </section>
            <section className="how-to-play-group" aria-label="Winning">
              <p className="how-to-play-group-label">Winning</p>
              <ul className="how-to-play-list">
                <li>
                  <strong className="how-to-play-marker">[+]</strong>
                  <div className="how-to-play-copy">
                    <span className="how-to-play-item-title">Win the Match</span>
                    <span className="how-to-play-item-description">The highest score wins. If the score is tied, the longer snake wins. If both are still tied, the match ends in a draw.</span>
                  </div>
                </li>
              </ul>
            </section>
          </div>
        </section>
      </section>

    </main>
  );
}
