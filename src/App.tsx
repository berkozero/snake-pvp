import { useEffect, useMemo, useRef, useState } from 'react';
import { BOARD_HEIGHT, BOARD_WIDTH, CELL_SIZE } from './game/constants';
import { formatTime } from './game/engine';
import type { Cell, PlayerId } from './game/types';
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
} from './net/protocol';
import SnakeWordmark from './SnakeWordmark';
import { getGameServerUrl } from './config';
import { getLobbySlotColors, getMatchPlayerColors, getRespawnPreviewColors } from './playerColors';

type ClientPayload = ClientMessage extends infer T
  ? T extends ClientMessage
    ? Omit<T, 'v' | 'roomId' | 'roundId'>
    : never
  : never;

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
    p1: { claimed: false, name: null, connected: false },
    p2: { claimed: false, name: null, connected: false },
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

function drawArena(ctx: CanvasRenderingContext2D, game: GameSnapshot | null, yourSlot: PlayerId | null): void {
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

  if (!game) {
    return;
  }

  const foodX = game.food.x * CELL_SIZE + CELL_SIZE / 2;
  const foodY = game.food.y * CELL_SIZE + CELL_SIZE / 2;
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
    const player = game.players[playerId];
    const colors = getMatchPlayerColors(playerId, yourSlot);
    player.segments.forEach((segment, index) => {
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

function getStatusMessage(phase: RoomPhase, yourSlot: PlayerId | null): string {
  if (phase === 'empty') {
    return 'Claim a slot to open the room.';
  }
  if (phase === 'waiting') {
    return yourSlot ? 'Waiting for the other player to connect.' : 'One slot is claimed. Join the other side.';
  }
  if (phase === 'ready') {
    return yourSlot ? 'Both players are here. Either player can start.' : 'Room is full and ready.';
  }
  if (phase === 'countdown') {
    return yourSlot ? 'Countdown live. Pre-turns are accepted now.' : 'Match starting.';
  }
  if (phase === 'playing') {
    return yourSlot ? 'Authoritative online match in progress.' : 'Match in progress.';
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

export default function App() {
  const [snapshot, setSnapshot] = useState<RoomSnapshotMessage>(EMPTY_SNAPSHOT);
  const [p1Name, setP1Name] = useState('');
  const [p2Name, setP2Name] = useState('');
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
          setMessage(getStatusMessage(incoming.phase, incoming.yourSlot));
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
      inputSeqRef.current += 1;
      sendMessage({
        type: 'input_direction',
        direction,
        inputSeq: inputSeqRef.current,
        clientTime: Date.now(),
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    drawArena(context, snapshot.game, snapshot.yourSlot);
  }, [snapshot]);

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

  const countdownLabel = useMemo(() => {
    if (snapshot.phase !== 'countdown' || !snapshot.game) {
      return null;
    }
    return `${Math.max(1, Math.ceil(snapshot.game.countdownMs / 800))}`;
  }, [snapshot]);

  const isLockedViewer =
    !snapshot.yourSlot &&
    (snapshot.phase === 'countdown' || snapshot.phase === 'playing' || snapshot.phase === 'ready') &&
    snapshot.slots.p1.claimed &&
    snapshot.slots.p2.claimed;
  const showLobbyOverlay =
    snapshot.phase === 'empty' ||
    snapshot.phase === 'waiting' ||
    (snapshot.phase === 'ready' && !isLockedViewer);
  const showPlayerClaims = !isLockedViewer;
  const canClaim = connected && snapshot.yourSlot === null;
  const canStart = connected && snapshot.yourSlot !== null && snapshot.phase === 'ready';
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
          <p className="menu-tagline">Three minutes. Outgrow or outcut.</p>
          <button
            data-testid="start-match"
            className="start-button"
            onClick={() => sendMessage({ type: 'start_match', requestId: nextRequestId() })}
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
          <article className="player-slot-card" data-testid="slot-p1">
            <div className="slot-row">
              <strong style={{ color: p1LobbyColors.text }}>{getPlayerName(snapshot, 'p1')}</strong>
              <span style={{ color: p1LobbyColors.status }}>{getSlotStatus(snapshot, 'p1')}</span>
              {!snapshot.slots.p1.claimed ? (
                <input
                  className="slot-input"
                  data-testid="name-input-p1"
                  value={p1Name}
                  maxLength={16}
                  onChange={(event) => setP1Name(event.target.value)}
                  placeholder="Enter handle"
                  disabled={!canClaim || !showPlayerClaims}
                />
              ) : null}
            </div>
            {showPlayerClaims && snapshot.yourSlot !== 'p1' ? (
              <button
                data-testid="claim-p1"
                onClick={() => sendMessage({ type: 'join_slot', requestId: nextRequestId(), slot: 'p1', name: p1Name })}
                disabled={!canClaim || (snapshot.slots.p1.claimed && snapshot.slots.p1.connected)}
              >
                Claim P1
              </button>
            ) : null}
            {snapshot.yourSlot === 'p1' ? (
              <button
                data-testid="leave-slot"
                className="secondary"
                onClick={() => {
                  window.localStorage.removeItem(RESUME_TOKEN_KEY);
                  resumeTokenRef.current = null;
                  sendMessage({ type: 'leave_slot', requestId: nextRequestId() });
                }}
                disabled={!connected}
              >
                Leave Slot
              </button>
            ) : null}
          </article>
          <article className="player-slot-card" data-testid="slot-p2">
            <div className="slot-row">
              <strong style={{ color: p2LobbyColors.text }}>{getPlayerName(snapshot, 'p2')}</strong>
              <span style={{ color: p2LobbyColors.status }}>{getSlotStatus(snapshot, 'p2')}</span>
              {!snapshot.slots.p2.claimed ? (
                <input
                  className="slot-input"
                  data-testid="name-input-p2"
                  value={p2Name}
                  maxLength={16}
                  onChange={(event) => setP2Name(event.target.value)}
                  placeholder="Enter handle"
                  disabled={!canClaim || !showPlayerClaims}
                />
              ) : null}
            </div>
            {showPlayerClaims && snapshot.yourSlot !== 'p2' ? (
              <button
                data-testid="claim-p2"
                className="secondary"
                onClick={() => sendMessage({ type: 'join_slot', requestId: nextRequestId(), slot: 'p2', name: p2Name })}
                disabled={!canClaim || (snapshot.slots.p2.claimed && snapshot.slots.p2.connected)}
              >
                Claim P2
              </button>
            ) : null}
            {snapshot.yourSlot === 'p2' ? (
              <button
                data-testid="leave-slot"
                className="secondary"
                onClick={() => {
                  window.localStorage.removeItem(RESUME_TOKEN_KEY);
                  resumeTokenRef.current = null;
                  sendMessage({ type: 'leave_slot', requestId: nextRequestId() });
                }}
                disabled={!connected}
              >
                Leave Slot
              </button>
            ) : null}
          </article>
        </div>
        <section className="how-to-play how-to-play-panel" aria-label="How to play">
          <h3>How to Play</h3>
          <ul className="how-to-play-list">
            <li>
              <strong>[+]</strong>
              <span>Claim a side</span>
              <span>Choose P1 or P2, enter a handle, and lock in your slot.</span>
            </li>
            <li>
              <strong>[+]</strong>
              <span>Start the round</span>
              <span>When both players connect, press Enter or use the start button.</span>
            </li>
            <li>
              <strong>[+]</strong>
              <span>Move with arrows</span>
              <span>Each player uses the arrow keys on their own browser window.</span>
            </li>
            <li>
              <strong>[+]</strong>
              <span>Score and grow</span>
              <span>Collect food to gain points and add length before time runs out.</span>
            </li>
            <li>
              <strong>[+]</strong>
              <span>Cut legally</span>
              <span>Hit enemy body segments only. Head and neck do not count as valid cuts.</span>
            </li>
            <li>
              <strong>[+]</strong>
              <span>Stay alive</span>
              <span>Deaths come from walls, your own body, or losing bad collisions.</span>
            </li>
            <li>
              <strong>[+]</strong>
              <span>Win the tiebreak</span>
              <span>Final result is score first, then current length if score is tied.</span>
            </li>
          </ul>
        </section>
      </section>

    </main>
  );
}
