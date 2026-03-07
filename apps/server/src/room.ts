import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MATCH_DURATION_MS,
  MOVEMENT_MS,
  TICK_MS,
  createInitialState,
  makeStartingSnake,
  applyDirection,
  canUseDirection,
  getRespawnRemainingMs,
  pickFoodCell,
  startCountdown,
  tick,
  EnvActionOrder,
  type Direction,
  type PlayerId,
  type RoundState,
} from '@snake/game-core';
import {
  PROTOCOL_VERSION,
  ROOM_ID,
  type ActionRejectedMessage,
  type ActionRejectedReason,
  type ClientMessage,
  type GameSnapshot,
  type JoinRejectedMessage,
  type JoinRejectedReason,
  type ResultReason,
  type ResultSnapshot,
  type RoomPhase,
  type RoomSnapshotMessage,
  type ServerMessage,
  type SlotController,
  type SlotSnapshot,
} from '@snake/game-core/protocol';
import type { LoadedRlPolicy } from './ai/rlPolicy';

type RandomSource = () => number;

export type SessionRecord = {
  sessionId: string;
  socketId: string;
  resumeToken: string;
  slot: PlayerId | null;
  name: string | null;
  connected: boolean;
  lastSeenAt: number;
  lastAcceptedInputSeq: number;
  pendingDirection: Direction | null;
  disconnectDeadline: number | null;
  rateWindowStartedAt: number;
  rateWindowCount: number;
};

type SlotState = {
  ownerSessionId: string | null;
  name: string | null;
  connected: boolean;
  controller: SlotController;
  reservedUntil: number | null;
};

const DEFAULT_AI_POLICY: LoadedRlPolicy = {
  metadata: {
    runId: 'built-in-stay',
    modelType: 'stub',
    inputSize: 44,
    hiddenSize: 32,
    hiddenSizes: [32, 32],
    outputSize: 5,
    actionOrder: [...EnvActionOrder],
    observationVersion: 2,
    exportVersion: 'rl-policy-v1',
  },
  selectAction() {
    return 'stay';
  },
};

type RoomOptions = {
  aiPolicy?: LoadedRlPolicy;
  now?: () => number;
  random?: RandomSource;
  tickMs?: number;
  movementMs?: number;
  countdownMs?: number;
  matchDurationMs?: number;
  livenessTimeoutMs?: number;
  disconnectGraceMs?: number;
  finishDwellMs?: number;
  rateLimitPerSecond?: number;
  emitToSession?: (socketId: string, message: ServerMessage) => void;
  log?: (event: string, context?: Record<string, string | number | boolean | null | undefined>) => void;
};

const SLOT_IDS: PlayerId[] = ['p1', 'p2'];
const AI_PLAYER_NAME = 'Pluribus';

function getOppositeSlot(slot: PlayerId): PlayerId {
  return slot === 'p1' ? 'p2' : 'p1';
}

function isClaimedSlot(slot: SlotState): boolean {
  return slot.controller !== 'none';
}

function isHumanControlledSlot(slot: SlotState): boolean {
  return slot.controller === 'human';
}

function isAiControlledSlot(slot: SlotState): boolean {
  return slot.controller === 'ai';
}

function makeSessionId(): string {
  return `session_${Math.random().toString(36).slice(2, 10)}`;
}

function makeRoundId(): string {
  return `round_${Math.random().toString(36).slice(2, 10)}`;
}

function makeResumeToken(): string {
  return `resume_${Math.random().toString(36).slice(2, 14)}`;
}

function cloneSegments(state: RoundState): GameSnapshot['players'] {
  return {
    p1: {
      alive: state.players.p1.alive,
      score: state.players.p1.score,
      direction: state.players.p1.direction,
      length: state.players.p1.segments.length,
      segments: state.players.p1.segments.map((segment) => ({ ...segment })),
      respawnRemainingMs: getRespawnRemainingMs(state.players.p1, state.clockMs),
      respawnPreview: state.players.p1.respawnPreview
        ? {
            head: { ...state.players.p1.respawnPreview.head },
            direction: state.players.p1.respawnPreview.direction,
          }
        : null,
    },
    p2: {
      alive: state.players.p2.alive,
      score: state.players.p2.score,
      direction: state.players.p2.direction,
      length: state.players.p2.segments.length,
      segments: state.players.p2.segments.map((segment) => ({ ...segment })),
      respawnRemainingMs: getRespawnRemainingMs(state.players.p2, state.clockMs),
      respawnPreview: state.players.p2.respawnPreview
        ? {
            head: { ...state.players.p2.respawnPreview.head },
            direction: state.players.p2.respawnPreview.direction,
          }
        : null,
    },
  };
}

function trimName(value: string): string {
  return value.trim();
}

function isDirection(value: unknown): value is Direction {
  return value === 'up' || value === 'down' || value === 'left' || value === 'right';
}

function makeLobbyState(random: RandomSource): RoundState {
  const seedPlayers = {
    p1: makeStartingSnake('p1'),
    p2: makeStartingSnake('p2'),
  };

  return createInitialState(pickFoodCell(seedPlayers, random));
}

export class MainRoom {
  readonly roomId = ROOM_ID;

  phase: RoomPhase = 'empty';
  roundId: string | null = null;
  tickSeq = 0;
  game: RoundState | null = null;
  result: ResultSnapshot | null = null;
  finishAt: number | null = null;
  readonly sessions = new Map<string, SessionRecord>();
  readonly slots: Record<PlayerId, SlotState> = {
    p1: { ownerSessionId: null, name: null, connected: false, controller: 'none', reservedUntil: null },
    p2: { ownerSessionId: null, name: null, connected: false, controller: 'none', reservedUntil: null },
  };

  private readonly aiPolicy: LoadedRlPolicy;
  private readonly now: () => number;
  private readonly random: RandomSource;
  private readonly tickMs: number;
  private readonly movementMs: number;
  private readonly countdownMs: number;
  private readonly matchDurationMs: number;
  private readonly livenessTimeoutMs: number;
  private readonly disconnectGraceMs: number;
  private readonly finishDwellMs: number;
  private readonly rateLimitPerSecond: number;
  private readonly emitToSession: (socketId: string, message: ServerMessage) => void;
  private readonly log: (event: string, context?: Record<string, string | number | boolean | null | undefined>) => void;
  private lastSimulationAt: number | null = null;
  private movementAccumulatorMs = 0;

  constructor(options: RoomOptions = {}) {
    this.aiPolicy = options.aiPolicy ?? DEFAULT_AI_POLICY;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.movementMs = options.movementMs ?? MOVEMENT_MS;
    this.countdownMs = options.countdownMs ?? 2_400;
    this.matchDurationMs = options.matchDurationMs ?? MATCH_DURATION_MS;
    this.livenessTimeoutMs = options.livenessTimeoutMs ?? 5_000;
    this.disconnectGraceMs = options.disconnectGraceMs ?? 3_000;
    this.finishDwellMs = options.finishDwellMs ?? 6_000;
    this.rateLimitPerSecond = options.rateLimitPerSecond ?? 40;
    this.emitToSession = options.emitToSession ?? (() => {});
    this.log = options.log ?? (() => {});
  }

  connect(socketId: string): SessionRecord {
    const now = this.now();
    const session: SessionRecord = {
      sessionId: makeSessionId(),
      socketId,
      resumeToken: makeResumeToken(),
      slot: null,
      name: null,
      connected: true,
      lastSeenAt: now,
      lastAcceptedInputSeq: -1,
      pendingDirection: null,
      disconnectDeadline: null,
      rateWindowStartedAt: now,
      rateWindowCount: 0,
    };

    this.sessions.set(socketId, session);
    this.log('connection_open', { socketId, sessionId: session.sessionId });
    this.emitSnapshot(socketId);
    return session;
  }

  disconnect(socketId: string, reason = 'socket_close'): void {
    const session = this.sessions.get(socketId);
    if (!session) {
      return;
    }

    this.log('connection_close', { socketId, sessionId: session.sessionId, reason });
    this.markDisconnected(session, reason);
  }

  handleMessage(socketId: string, raw: string): void {
    const session = this.sessions.get(socketId);
    if (!session) {
      return;
    }

    if (!this.checkRateLimit(session)) {
      this.log('message_rate_limited', { socketId, sessionId: session.sessionId });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log('message_ignored', { socketId, reason: 'invalid_json' });
      return;
    }

    if (!this.isSupportedEnvelope(parsed)) {
      this.log('message_ignored', { socketId, reason: 'unsupported_message' });
      return;
    }

    const message = parsed as ClientMessage;
    session.lastSeenAt = this.now();

    if (!this.isRoundValid(message)) {
      this.rejectAction(session, 'requestId' in message ? message.requestId : null, 'invalid_phase');
      this.log('invalid_round', {
        socketId,
        sessionId: session.sessionId,
        messageType: message.type,
        messageRoundId: message.roundId,
        currentRoundId: this.roundId,
      });
      return;
    }

    switch (message.type) {
      case 'ping':
        this.emitToSession(socketId, {
          v: PROTOCOL_VERSION,
          type: 'pong',
          roomId: ROOM_ID,
          roundId: this.roundId,
          serverTime: this.now(),
        });
        return;
      case 'join_slot':
        this.handleJoin(session, message);
        return;
      case 'resume_session':
        this.handleResume(session, message.requestId, message.resumeToken);
        return;
      case 'leave_slot':
        this.handleLeave(session, message.requestId);
        return;
      case 'start_match':
        this.handleStart(session, message.requestId);
        return;
      case 'input_direction':
        this.handleInput(session, message.direction, message.inputSeq);
        return;
      case 'set_ai_slot':
        this.handleSetAiSlot(session, message.requestId, message.slot, message.enabled);
        return;
    }
  }

  tick(): void {
    const now = this.now();
    const elapsedMs = this.getElapsedTickMs(now);

    for (const session of this.sessions.values()) {
      if (session.connected && now - session.lastSeenAt > this.livenessTimeoutMs) {
        this.markDisconnected(session, 'liveness_timeout');
      }
    }

    for (const session of this.sessions.values()) {
      if (
        session.slot &&
        session.disconnectDeadline !== null &&
        now >= session.disconnectDeadline
      ) {
        this.handleGraceExpiry(session);
      }
    }

    if (this.phase === 'countdown' || this.phase === 'playing') {
      if (!this.game) {
        return;
      }

      if (elapsedMs > 0) {
        let remainingElapsedMs = elapsedMs;

        if (this.phase === 'countdown' && this.game.phase === 'countdown') {
          const countdownStepMs = Math.min(remainingElapsedMs, this.game.countdownMs);
          const countdownResult = tick(this.game, countdownStepMs, now, { random: this.random, shouldMove: false });
          this.game = countdownResult.state;
          if (countdownResult.didAdvanceBoard) {
            this.tickSeq += 1;
          }
          remainingElapsedMs -= countdownStepMs;

          if (this.game.phase === 'playing') {
            this.phase = 'playing';
            this.movementAccumulatorMs = 0;
          }
        }

        if (remainingElapsedMs > 0 && this.phase === 'playing' && this.game.phase === 'playing') {
          const playTimerResult = tick(this.game, remainingElapsedMs, now, { random: this.random, shouldMove: false });
          this.game = playTimerResult.state;
          if (playTimerResult.didAdvanceBoard) {
            this.tickSeq += 1;
          }
          this.movementAccumulatorMs += remainingElapsedMs;
        }

        while (this.phase === 'playing' && this.game.phase === 'playing' && this.movementAccumulatorMs >= this.movementMs) {
          this.submitBotDirections();
          const moveResult = tick(this.game, 0, now, { random: this.random, shouldMove: true });
          this.game = moveResult.state;
          this.movementAccumulatorMs -= this.movementMs;
          if (moveResult.didAdvanceBoard) {
            this.tickSeq += 1;
          }
          if (this.game.phase === 'finished') {
            break;
          }
        }

        if (this.game.phase === 'finished') {
          this.phase = 'finished';
          this.result = {
            winner: this.game.winner ?? 'draw',
            reason: 'timeout',
            forfeitSlot: null,
          };
          this.finishAt = now + this.finishDwellMs;
          this.movementAccumulatorMs = 0;
          this.log('timeout_finish', { roundId: this.roundId, winner: this.result.winner });
        }
      }

      this.broadcastSnapshot();
    }

    if (this.phase === 'finished' && this.finishAt !== null && now >= this.finishAt) {
      this.resetRoom();
      this.broadcastSnapshot();
    }
  }

  snapshotFor(socketId: string | null): RoomSnapshotMessage {
    const session = socketId ? this.sessions.get(socketId) ?? null : null;
    const slots: Record<PlayerId, SlotSnapshot> = {
      p1: {
        claimed: isClaimedSlot(this.slots.p1),
        name: this.slots.p1.name,
        connected: this.slots.p1.connected,
        controller: this.slots.p1.controller,
      },
      p2: {
        claimed: isClaimedSlot(this.slots.p2),
        name: this.slots.p2.name,
        connected: this.slots.p2.connected,
        controller: this.slots.p2.controller,
      },
    };

    return {
      v: PROTOCOL_VERSION,
      type: 'room_snapshot',
      roomId: ROOM_ID,
      roundId: this.roundId,
      serverTime: this.now(),
      phase: this.phase,
      tickSeq: this.tickSeq,
      yourSlot: session?.slot ?? null,
      resumeToken: session?.slot ? session.resumeToken : null,
      slots,
      game: this.game
        ? {
            board: { width: BOARD_WIDTH, height: BOARD_HEIGHT },
            countdownMs: this.game.countdownMs,
            remainingMs: this.game.remainingMs,
            food: { ...this.game.food },
            players: cloneSegments(this.game),
          }
        : null,
      result: this.result,
    };
  }

  private isSupportedEnvelope(value: unknown): value is { v: number; type: string; roomId: string; roundId: string | null } {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const envelope = value as Record<string, unknown>;
    return (
      envelope.v === PROTOCOL_VERSION &&
      envelope.roomId === ROOM_ID &&
      typeof envelope.type === 'string' &&
      (typeof envelope.roundId === 'string' || envelope.roundId === null)
    );
  }

  private isRoundValid(message: ClientMessage): boolean {
    if (message.type === 'join_slot' || message.type === 'ping' || message.type === 'resume_session') {
      return true;
    }

    return message.roundId === this.roundId;
  }

  private checkRateLimit(session: SessionRecord): boolean {
    const now = this.now();
    if (now - session.rateWindowStartedAt >= 1_000) {
      session.rateWindowStartedAt = now;
      session.rateWindowCount = 0;
    }

    session.rateWindowCount += 1;
    return session.rateWindowCount <= this.rateLimitPerSecond;
  }

  private handleJoin(
    session: SessionRecord,
    message: Extract<ClientMessage, { type: 'join_slot' }>,
  ): void {
    if (session.slot) {
      this.rejectJoin(session, message.requestId, 'already_claimed');
      return;
    }

    if (this.phase === 'countdown' || this.phase === 'playing' || this.phase === 'finished') {
      this.rejectJoin(session, message.requestId, 'room_locked');
      return;
    }

    const name = trimName(message.name);
    if (!name || name.length > 16) {
      this.rejectJoin(session, message.requestId, 'invalid_name');
      return;
    }

    const slotState = this.slots[message.slot];
    if (isClaimedSlot(slotState)) {
      this.rejectJoin(
        session,
        message.requestId,
        slotState.connected ? 'slot_taken' : 'slot_reserved',
      );
      return;
    }

    const lower = name.toLocaleLowerCase();
    for (const slotId of SLOT_IDS) {
      const existingName = this.slots[slotId].name;
      if (existingName && existingName.toLocaleLowerCase() === lower) {
        this.rejectJoin(session, message.requestId, 'duplicate_name');
        return;
      }
    }

    slotState.ownerSessionId = session.sessionId;
    slotState.name = name;
    slotState.connected = true;
    slotState.controller = 'human';
    slotState.reservedUntil = null;
    session.slot = message.slot;
    session.name = name;
    session.connected = true;
    session.disconnectDeadline = null;
    session.pendingDirection = null;
    session.lastAcceptedInputSeq = -1;
    this.refreshLobbyPhase();

    this.log('join_accepted', {
      socketId: session.socketId,
      sessionId: session.sessionId,
      slot: message.slot,
      name,
      phase: this.phase,
    });
    this.broadcastSnapshot();
  }

  private handleResume(session: SessionRecord, requestId: string, resumeToken: string): void {
    if (session.slot) {
      this.rejectAction(session, requestId, 'invalid_phase');
      return;
    }

    const target = this.findSessionByResumeToken(resumeToken);
    if (!target || !target.slot) {
      this.rejectAction(session, requestId, 'not_owner');
      return;
    }

    const slotState = this.slots[target.slot];
    if (
      slotState.controller !== 'human' ||
      slotState.ownerSessionId !== target.sessionId ||
      (!target.connected &&
        (slotState.reservedUntil === null || this.now() >= slotState.reservedUntil))
    ) {
      this.rejectAction(session, requestId, 'invalid_phase');
      return;
    }

    this.sessions.delete(session.socketId);
    this.sessions.delete(target.socketId);
    target.socketId = session.socketId;
    target.connected = true;
    target.lastSeenAt = this.now();
    target.disconnectDeadline = null;
    target.rateWindowStartedAt = this.now();
    target.rateWindowCount = 0;
    slotState.connected = true;
    slotState.reservedUntil = null;
    this.sessions.set(target.socketId, target);

    if (this.phase === 'waiting' || this.phase === 'ready') {
      this.refreshLobbyPhase();
    }

    this.log('session_resumed', {
      sessionId: target.sessionId,
      socketId: target.socketId,
      slot: target.slot,
      phase: this.phase,
    });
    this.broadcastSnapshot();
  }

  private handleLeave(session: SessionRecord, requestId: string): void {
    if (!session.slot) {
      this.rejectAction(session, requestId, 'not_owner');
      return;
    }

    if (this.phase === 'playing' || this.phase === 'finished') {
      this.rejectAction(session, requestId, 'invalid_phase');
      return;
    }

    const slot = session.slot;
    this.releaseSlot(slot, session);

    if (this.phase === 'countdown') {
      this.cancelCountdown();
    } else {
      this.refreshLobbyPhase();
    }

    this.log('leave', { socketId: session.socketId, sessionId: session.sessionId, slot });
    this.broadcastSnapshot();
  }

  private handleSetAiSlot(session: SessionRecord, requestId: string, slot: PlayerId, enabled: boolean): void {
    if (this.phase === 'countdown' || this.phase === 'playing' || this.phase === 'finished') {
      this.rejectAction(session, requestId, 'invalid_phase');
      return;
    }

    if (session.slot && (session.slot === slot || getOppositeSlot(session.slot) !== slot)) {
      this.rejectAction(session, requestId, 'invalid_phase');
      return;
    }

    const targetSlot = this.slots[slot];
    if (enabled) {
      if (isClaimedSlot(targetSlot)) {
        this.rejectAction(session, requestId, 'invalid_phase');
        return;
      }

      targetSlot.ownerSessionId = null;
      targetSlot.name = AI_PLAYER_NAME;
      targetSlot.connected = true;
      targetSlot.controller = 'ai';
      targetSlot.reservedUntil = null;
      this.refreshLobbyPhase();
      this.log('ai_slot_enabled', {
        socketId: session.socketId,
        sessionId: session.sessionId,
        ownerSlot: session.slot,
        aiSlot: slot,
      });
      this.broadcastSnapshot();
      return;
    }

    if (!isAiControlledSlot(targetSlot)) {
      this.rejectAction(session, requestId, 'invalid_phase');
      return;
    }

    this.clearAiSlot(slot);
    this.refreshLobbyPhase();
    this.log('ai_slot_disabled', {
      socketId: session.socketId,
      sessionId: session.sessionId,
      ownerSlot: session.slot,
      aiSlot: slot,
    });
    this.broadcastSnapshot();
  }

  private handleStart(session: SessionRecord, requestId: string): void {
    if (!session.slot && !this.isViewerSession(session)) {
      this.rejectAction(session, requestId, 'not_owner');
      return;
    }

    if (this.phase !== 'ready') {
      this.rejectAction(session, requestId, 'invalid_phase');
      return;
    }

    if (!this.slots.p1.connected || !this.slots.p2.connected) {
      this.rejectAction(session, requestId, 'invalid_phase');
      return;
    }

    this.game = startCountdown(makeLobbyState(this.random));
    this.game = {
      ...this.game,
      countdownMs: this.countdownMs,
      remainingMs: this.matchDurationMs,
      tickMs: this.tickMs,
      movementMs: this.movementMs,
    };
    this.phase = 'countdown';
    this.roundId = makeRoundId();
    this.tickSeq = 0;
    this.result = null;
    this.finishAt = null;
    this.lastSimulationAt = this.now();
    this.movementAccumulatorMs = 0;
    this.syncSessionPendingDirections();
    this.submitBotDirections();

    this.log('start_accepted', {
      socketId: session.socketId,
      sessionId: session.sessionId,
      roundId: this.roundId,
    });
    this.broadcastSnapshot();
  }

  private handleInput(session: SessionRecord, direction: Direction, inputSeq: number): void {
    if (!session.slot) {
      this.rejectAction(session, null, 'not_owner');
      return;
    }

    if (this.phase !== 'countdown' && this.phase !== 'playing') {
      this.rejectAction(session, null, 'invalid_phase');
      return;
    }

    if (!Number.isInteger(inputSeq) || inputSeq <= session.lastAcceptedInputSeq) {
      this.rejectAction(session, null, 'stale_input');
      this.log('stale_input', { socketId: session.socketId, inputSeq });
      return;
    }

    if (!isDirection(direction) || !this.game) {
      this.rejectAction(session, null, 'invalid_direction');
      return;
    }

    const player = this.game.players[session.slot];
    if (!this.tryApplyDirection(player.id, direction)) {
      this.rejectAction(session, null, 'invalid_direction');
      return;
    }
    session.lastAcceptedInputSeq = inputSeq;
    session.pendingDirection = direction;
  }

  private syncSessionPendingDirections(): void {
    if (!this.game) {
      return;
    }

    for (const session of this.sessions.values()) {
      if (session.slot) {
        session.pendingDirection = this.game.players[session.slot].pendingDirection;
      }
    }
  }

  private tryApplyDirection(playerId: PlayerId, direction: Direction): boolean {
    if (!this.game) {
      return false;
    }

    const nextState = applyDirection(this.game, playerId, direction);
    const accepted = nextState.players[playerId].pendingDirection === direction;
    if (!accepted) {
      return false;
    }

    this.game = nextState;
    return true;
  }

  private submitBotDirections(): void {
    if (!this.game || (this.phase !== 'countdown' && this.phase !== 'playing')) {
      return;
    }

    for (const slot of SLOT_IDS) {
      if (!isAiControlledSlot(this.slots[slot])) {
        continue;
      }

      const action = this.aiPolicy.selectAction(this.game, slot);
      if (action === 'stay' || !EnvActionOrder.includes(action)) {
        continue;
      }

      const player = this.game.players[slot];
      if (!player.alive || !canUseDirection(player.direction, action)) {
        continue;
      }

      this.tryApplyDirection(slot, action);
    }
  }

  private clearAiSlot(slot: PlayerId): void {
    this.slots[slot] = {
      ownerSessionId: null,
      name: null,
      connected: false,
      controller: 'none',
      reservedUntil: null,
    };
  }

  private isViewerSession(session: SessionRecord): boolean {
    return session.slot === null && session.connected;
  }

  private markDisconnected(session: SessionRecord, reason: string): void {
    if (!session.connected) {
      return;
    }

    session.connected = false;
    session.lastSeenAt = this.now();

    if (!session.slot) {
      this.sessions.delete(session.socketId);
      return;
    }

    const slotState = this.slots[session.slot];
    slotState.connected = false;
    slotState.reservedUntil = this.now() + this.disconnectGraceMs;
    session.disconnectDeadline = slotState.reservedUntil;

    this.log('grace_start', {
      socketId: session.socketId,
      sessionId: session.sessionId,
      slot: session.slot,
      reason,
      expiresAt: slotState.reservedUntil,
    });

    if (this.phase === 'ready') {
      this.phase = 'waiting';
      this.broadcastSnapshot();
      return;
    }

    if (this.phase === 'countdown') {
      this.cancelCountdown();
      this.log('countdown_cancel', { roundId: this.roundId, slot: session.slot });
      this.broadcastSnapshot();
      return;
    }

    if (this.phase === 'waiting') {
      this.broadcastSnapshot();
      return;
    }

    if (this.phase === 'playing') {
      this.broadcastSnapshot();
      return;
    }

    if (this.phase === 'finished') {
      return;
    }
  }

  private handleGraceExpiry(session: SessionRecord): void {
    if (!session.slot) {
      return;
    }

    const slot = session.slot;
    session.disconnectDeadline = null;

    if (this.phase === 'playing') {
      const winner = slot === 'p1' ? 'p2' : 'p1';
      this.phase = 'finished';
      this.result = {
        winner,
        reason: 'forfeit',
        forfeitSlot: slot,
      };
      this.finishAt = this.now() + this.finishDwellMs;
      this.movementAccumulatorMs = 0;
      this.log('forfeit', { roundId: this.roundId, forfeitSlot: slot, winner });
      this.cleanupDisconnectedSessions();
      this.broadcastSnapshot();
      return;
    }

    this.log('grace_expiry', { sessionId: session.sessionId, slot });
    this.releaseSlot(slot, session);
    this.refreshLobbyPhase();
    this.broadcastSnapshot();
  }

  private cancelCountdown(): void {
    this.game = null;
    this.roundId = null;
    this.tickSeq = 0;
    this.result = null;
    this.finishAt = null;
    this.lastSimulationAt = null;
    this.movementAccumulatorMs = 0;
    this.refreshLobbyPhase();
  }

  private refreshLobbyPhase(): void {
    if (this.phase === 'playing' || this.phase === 'finished') {
      return;
    }

    const claimed = SLOT_IDS.filter((slot) => isClaimedSlot(this.slots[slot]));
    const connectedClaimed = claimed.filter((slot) => this.slots[slot].connected);

    if (claimed.length === 0) {
      this.phase = 'empty';
      return;
    }

    if (connectedClaimed.length === 2 && claimed.length === 2) {
      this.phase = 'ready';
      return;
    }

    this.phase = 'waiting';
  }

  private releaseSlot(slot: PlayerId, session: SessionRecord): void {
    const slotState = this.slots[slot];
    slotState.ownerSessionId = null;
    slotState.name = null;
    slotState.connected = false;
    slotState.controller = 'none';
    slotState.reservedUntil = null;

    session.slot = null;
    session.name = null;
    session.pendingDirection = null;
    session.lastAcceptedInputSeq = -1;

    if (!session.connected) {
      this.sessions.delete(session.socketId);
    }
  }

  private resetRoom(): void {
    for (const slot of SLOT_IDS) {
      const owner = this.findSessionBySlot(slot);
      if (owner) {
        owner.slot = null;
        owner.name = null;
        owner.pendingDirection = null;
        owner.lastAcceptedInputSeq = -1;
      }

      this.slots[slot] = {
        ownerSessionId: null,
        name: null,
        connected: false,
        controller: 'none',
        reservedUntil: null,
      };
    }

    this.phase = 'empty';
    this.roundId = null;
    this.tickSeq = 0;
    this.game = null;
    this.result = null;
    this.finishAt = null;
    this.lastSimulationAt = null;
    this.movementAccumulatorMs = 0;
    this.cleanupDisconnectedSessions();
    this.log('room_reset', {});
  }

  private findSessionBySlot(slot: PlayerId): SessionRecord | null {
    const ownerSessionId = this.slots[slot].ownerSessionId;
    if (!ownerSessionId) {
      return null;
    }

    for (const session of this.sessions.values()) {
      if (session.sessionId === ownerSessionId) {
        return session;
      }
    }

    return null;
  }

  private findSessionByResumeToken(resumeToken: string): SessionRecord | null {
    for (const session of this.sessions.values()) {
      if (session.resumeToken === resumeToken) {
        return session;
      }
    }

    return null;
  }

  private cleanupDisconnectedSessions(): void {
    for (const [socketId, session] of this.sessions.entries()) {
      if (!session.connected && session.slot === null) {
        this.sessions.delete(socketId);
      }
    }
  }

  private rejectJoin(session: SessionRecord, requestId: string, reason: JoinRejectedReason): void {
    const message: JoinRejectedMessage = {
      v: PROTOCOL_VERSION,
      type: 'join_rejected',
      roomId: ROOM_ID,
      roundId: this.roundId,
      requestId,
      reason,
    };

    this.log('join_rejected', { socketId: session.socketId, sessionId: session.sessionId, reason });
    this.emitToSession(session.socketId, message);
  }

  private rejectAction(session: SessionRecord, requestId: string | null, reason: ActionRejectedReason): void {
    const message: ActionRejectedMessage = {
      v: PROTOCOL_VERSION,
      type: 'action_rejected',
      roomId: ROOM_ID,
      roundId: this.roundId,
      requestId,
      reason,
    };

    this.log('action_rejected', { socketId: session.socketId, sessionId: session.sessionId, reason });
    this.emitToSession(session.socketId, message);
  }

  private emitSnapshot(socketId: string): void {
    this.emitToSession(socketId, this.snapshotFor(socketId));
  }

  private getElapsedTickMs(now: number): number {
    if (this.lastSimulationAt === null) {
      this.lastSimulationAt = now;
      return 0;
    }

    const elapsedMs = Math.max(0, now - this.lastSimulationAt);
    this.lastSimulationAt = now;
    return elapsedMs;
  }

  private broadcastSnapshot(): void {
    for (const session of this.sessions.values()) {
      if (session.connected) {
        this.emitSnapshot(session.socketId);
      }
    }
  }
}

export function createRoomForTests(options: RoomOptions = {}): MainRoom {
  return new MainRoom({
    ...options,
    tickMs: options.tickMs ?? 50,
    movementMs: options.movementMs ?? 100,
  });
}

export const DEFAULT_MATCH_DURATION_MS = MATCH_DURATION_MS;
