import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, ROOM_ID, type RoomSnapshotMessage } from '@snake/game-core/protocol';
import { getStatusMessage, getViewerUiState } from './App';

function makeSnapshot(overrides: Partial<RoomSnapshotMessage> = {}): RoomSnapshotMessage {
  return {
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
    ...overrides,
  };
}

describe('viewer watch mode', () => {
  it('keeps AI-only ready rooms startable for watchers', () => {
    const snapshot = makeSnapshot({
      phase: 'ready',
      slots: {
        p1: { claimed: true, name: 'Pluribus', connected: true, controller: 'ai' },
        p2: { claimed: true, name: 'Pluribus', connected: true, controller: 'ai' },
      },
    });

    expect(getViewerUiState(snapshot, true)).toEqual({
      isWatcher: true,
      isAiOnlyRoom: true,
      isLockedViewer: false,
      showWatchOverlay: false,
      showLobbyOverlay: true,
      showPlayerClaims: false,
      canClaim: false,
      canStart: true,
    });
    expect(getStatusMessage(snapshot)).toBe('AI match ready. Start to watch.');
  });

  it('shows watch mode during an AI-only countdown', () => {
    const snapshot = makeSnapshot({
      phase: 'countdown',
      slots: {
        p1: { claimed: true, name: 'Pluribus', connected: true, controller: 'ai' },
        p2: { claimed: true, name: 'Pluribus', connected: true, controller: 'ai' },
      },
    });

    expect(getViewerUiState(snapshot, true)).toEqual({
      isWatcher: true,
      isAiOnlyRoom: true,
      isLockedViewer: false,
      showWatchOverlay: true,
      showLobbyOverlay: false,
      showPlayerClaims: false,
      canClaim: false,
      canStart: false,
    });
    expect(getStatusMessage(snapshot)).toBe('Watching AI match. Countdown live.');
  });

  it('shows watch mode during AI-only play', () => {
    const snapshot = makeSnapshot({
      phase: 'playing',
      slots: {
        p1: { claimed: true, name: 'Pluribus', connected: true, controller: 'ai' },
        p2: { claimed: true, name: 'Pluribus', connected: true, controller: 'ai' },
      },
    });

    expect(getViewerUiState(snapshot, true)).toEqual({
      isWatcher: true,
      isAiOnlyRoom: true,
      isLockedViewer: false,
      showWatchOverlay: true,
      showLobbyOverlay: false,
      showPlayerClaims: false,
      canClaim: false,
      canStart: false,
    });
    expect(getStatusMessage(snapshot)).toBe('Watching AI match.');
  });

  it('keeps non-AI ready rooms locked for outside viewers', () => {
    const snapshot = makeSnapshot({
      phase: 'ready',
      slots: {
        p1: { claimed: true, name: 'Alpha', connected: true, controller: 'human' },
        p2: { claimed: true, name: 'Pluribus', connected: true, controller: 'ai' },
      },
    });

    expect(getViewerUiState(snapshot, true)).toEqual({
      isWatcher: true,
      isAiOnlyRoom: false,
      isLockedViewer: true,
      showWatchOverlay: false,
      showLobbyOverlay: false,
      showPlayerClaims: false,
      canClaim: false,
      canStart: false,
    });
    expect(getStatusMessage(snapshot)).toBe('Room is full and ready.');
  });

  it('preserves ready-state controls for the owning player', () => {
    const snapshot = makeSnapshot({
      phase: 'ready',
      yourSlot: 'p1',
      slots: {
        p1: { claimed: true, name: 'Alpha', connected: true, controller: 'human' },
        p2: { claimed: true, name: 'Bravo', connected: true, controller: 'human' },
      },
    });

    expect(getViewerUiState(snapshot, true)).toEqual({
      isWatcher: false,
      isAiOnlyRoom: false,
      isLockedViewer: false,
      showWatchOverlay: false,
      showLobbyOverlay: true,
      showPlayerClaims: false,
      canClaim: false,
      canStart: true,
    });
    expect(getStatusMessage(snapshot)).toBe('Both sides are ready. Either human can start.');
  });
});
