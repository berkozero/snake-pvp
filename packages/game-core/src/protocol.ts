import type { Cell, Direction, PlayerId, RespawnPreview } from './types';

export const PROTOCOL_VERSION = 1;
export const ROOM_ID = 'main';

export type RoomPhase = 'empty' | 'waiting' | 'ready' | 'countdown' | 'playing' | 'finished';
export type ResultReason = 'timeout' | 'forfeit';
export type SlotController = 'none' | 'human' | 'ai';
export type JoinRejectedReason =
  | 'slot_taken'
  | 'duplicate_name'
  | 'invalid_name'
  | 'room_locked'
  | 'already_claimed'
  | 'slot_reserved';
export type ActionRejectedReason = 'not_owner' | 'invalid_phase' | 'stale_input' | 'invalid_direction';

export type SlotSnapshot = {
  claimed: boolean;
  name: string | null;
  connected: boolean;
  controller: SlotController;
};

export type GamePlayerSnapshot = {
  alive: boolean;
  score: number;
  direction: Direction;
  length: number;
  segments: Cell[];
  respawnRemainingMs: number;
  respawnPreview: RespawnPreview | null;
};

export type GameSnapshot = {
  board: {
    width: number;
    height: number;
  };
  countdownMs: number;
  remainingMs: number;
  food: Cell;
  players: Record<PlayerId, GamePlayerSnapshot>;
};

export type ResultSnapshot = {
  winner: PlayerId | 'draw';
  reason: ResultReason;
  forfeitSlot: PlayerId | null;
};

type EnvelopeBase = {
  v: typeof PROTOCOL_VERSION;
  roomId: typeof ROOM_ID;
  roundId: string | null;
};

export type JoinSlotMessage = EnvelopeBase & {
  type: 'join_slot';
  requestId: string;
  slot: PlayerId;
  name: string;
};

export type LeaveSlotMessage = EnvelopeBase & {
  type: 'leave_slot';
  requestId: string;
};

export type StartMatchMessage = EnvelopeBase & {
  type: 'start_match';
  requestId: string;
};

export type ResumeSessionMessage = EnvelopeBase & {
  type: 'resume_session';
  requestId: string;
  resumeToken: string;
};

export type InputDirectionMessage = EnvelopeBase & {
  type: 'input_direction';
  direction: Direction;
  inputSeq: number;
  clientTime: number;
};

export type PingMessage = EnvelopeBase & {
  type: 'ping';
  clientTime: number;
};

export type SetAiSlotMessage = EnvelopeBase & {
  type: 'set_ai_slot';
  requestId: string;
  slot: PlayerId;
  enabled: boolean;
};

export type ClientMessage =
  | JoinSlotMessage
  | LeaveSlotMessage
  | StartMatchMessage
  | ResumeSessionMessage
  | InputDirectionMessage
  | PingMessage
  | SetAiSlotMessage;

export type RoomSnapshotMessage = EnvelopeBase & {
  type: 'room_snapshot';
  serverTime: number;
  phase: RoomPhase;
  tickSeq: number;
  yourSlot: PlayerId | null;
  resumeToken: string | null;
  slots: Record<PlayerId, SlotSnapshot>;
  game: GameSnapshot | null;
  result: ResultSnapshot | null;
};

export type JoinRejectedMessage = EnvelopeBase & {
  type: 'join_rejected';
  requestId: string;
  reason: JoinRejectedReason;
};

export type ActionRejectedMessage = EnvelopeBase & {
  type: 'action_rejected';
  requestId: string | null;
  reason: ActionRejectedReason;
};

export type PongMessage = EnvelopeBase & {
  type: 'pong';
  serverTime: number;
};

export type ServerMessage =
  | RoomSnapshotMessage
  | JoinRejectedMessage
  | ActionRejectedMessage
  | PongMessage;
