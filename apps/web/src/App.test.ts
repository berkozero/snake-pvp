import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BOARD_HEIGHT, BOARD_WIDTH } from '@snake/game-core';
import { PROTOCOL_VERSION, ROOM_ID, type RoomSnapshotMessage } from '@snake/game-core/protocol';
import { GameplayHud, getResignableSlots, getResultEyebrow, getStatusMessage, getViewerUiState, getWinnerLabel } from './App';
import { getMatchPlayerColors } from './playerColors';

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

function makeLiveSnapshot(overrides: Partial<RoomSnapshotMessage> = {}): RoomSnapshotMessage {
  return makeSnapshot({
    phase: 'playing',
    yourSlot: 'p1',
    slots: {
      p1: { claimed: true, name: 'Alpha Unit', connected: true, controller: 'human' },
      p2: { claimed: true, name: 'Bravo Bot', connected: true, controller: 'ai' },
    },
    game: {
      board: { width: BOARD_WIDTH, height: BOARD_HEIGHT },
      remainingMs: 61_000,
      countdownMs: 0,
      food: { x: 8, y: 8 },
      players: {
        p1: {
          alive: true,
          score: 7,
          direction: 'right',
          length: 1,
          segments: [{ x: 2, y: 2 }],
          respawnRemainingMs: 0,
          respawnPreview: null,
        },
        p2: {
          alive: true,
          score: 12,
          direction: 'left',
          length: 1,
          segments: [{ x: 10, y: 10 }],
          respawnRemainingMs: 0,
          respawnPreview: null,
        },
      },
    },
    ...overrides,
  });
}

function renderGameplayHud(snapshot: RoomSnapshotMessage, pendingResignSlot: 'p1' | 'p2' | null = null): string {
  return renderToStaticMarkup(
    createElement(GameplayHud, {
      snapshot,
      resignableSlots: getResignableSlots(snapshot, true),
      pendingResignSlot,
      p1MatchColors: getMatchPlayerColors('p1', snapshot.yourSlot),
      p2MatchColors: getMatchPlayerColors('p2', snapshot.yourSlot),
      onToggleResign: () => undefined,
      onConfirmResign: () => undefined,
      onCancelResign: () => undefined,
    }),
  );
}

describe('viewer watch mode', () => {
  it('keeps AI-only ready rooms startable for watchers', () => {
    const snapshot = makeSnapshot({
      phase: 'ready',
      slots: {
        p1: { claimed: true, name: 'AI', connected: true, controller: 'ai' },
        p2: { claimed: true, name: 'AI', connected: true, controller: 'ai' },
      },
    });

    expect(getViewerUiState(snapshot, true)).toEqual({
      isWatcher: true,
      isAiOnlyRoom: true,
      isLockedViewer: false,
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
        p1: { claimed: true, name: 'AI', connected: true, controller: 'ai' },
        p2: { claimed: true, name: 'AI', connected: true, controller: 'ai' },
      },
    });

    expect(getViewerUiState(snapshot, true)).toEqual({
      isWatcher: true,
      isAiOnlyRoom: true,
      isLockedViewer: false,
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
        p1: { claimed: true, name: 'AI', connected: true, controller: 'ai' },
        p2: { claimed: true, name: 'AI', connected: true, controller: 'ai' },
      },
    });

    expect(getViewerUiState(snapshot, true)).toEqual({
      isWatcher: true,
      isAiOnlyRoom: true,
      isLockedViewer: false,
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
        p2: { claimed: true, name: 'AI', connected: true, controller: 'ai' },
      },
    });

    expect(getViewerUiState(snapshot, true)).toEqual({
      isWatcher: true,
      isAiOnlyRoom: false,
      isLockedViewer: true,
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
      showLobbyOverlay: true,
      showPlayerClaims: false,
      canClaim: false,
      canStart: true,
    });
    expect(getStatusMessage(snapshot)).toBe('Both sides are ready. Either human can start.');
  });

  it('renders resign-specific result copy without affecting forfeit copy', () => {
    const base = makeSnapshot({
      phase: 'finished',
      slots: {
        p1: { claimed: true, name: 'Alpha', connected: true, controller: 'human' },
        p2: { claimed: true, name: 'Bravo', connected: true, controller: 'human' },
      },
    });

    expect(getWinnerLabel({ winner: 'p1', reason: 'resign', forfeitSlot: null }, base)).toBe('Alpha Wins by Resignation');
    expect(getResultEyebrow({ winner: 'p1', reason: 'resign', forfeitSlot: null })).toBe('Resignation');
    expect(getWinnerLabel({ winner: 'p2', reason: 'forfeit', forfeitSlot: 'p1' }, base)).toBe('Bravo Wins by Forfeit');
    expect(getResultEyebrow({ winner: 'p2', reason: 'forfeit', forfeitSlot: 'p1' })).toBe('Forfeit');
  });

  it('exposes resign controls only for eligible sides', () => {
    const humanOwner = makeSnapshot({
      phase: 'playing',
      yourSlot: 'p1',
      slots: {
        p1: { claimed: true, name: 'Alpha', connected: true, controller: 'human' },
        p2: { claimed: true, name: 'Bravo', connected: true, controller: 'human' },
      },
    });
    expect(getResignableSlots(humanOwner, true)).toEqual({ p1: true, p2: false });

    const aiViewer = makeSnapshot({
      phase: 'countdown',
      slots: {
        p1: { claimed: true, name: 'AI', connected: true, controller: 'ai' },
        p2: { claimed: true, name: 'AI', connected: true, controller: 'ai' },
      },
    });
    expect(getResignableSlots(aiViewer, true)).toEqual({ p1: true, p2: true });

    const outsideViewer = makeSnapshot({
      phase: 'playing',
      slots: {
        p1: { claimed: true, name: 'Alpha', connected: true, controller: 'human' },
        p2: { claimed: true, name: 'AI', connected: true, controller: 'ai' },
      },
    });
    expect(getResignableSlots(outsideViewer, true)).toEqual({ p1: false, p2: false });
    expect(getResignableSlots(humanOwner, false)).toEqual({ p1: false, p2: false });
  });

  it('renders AI in winner copy when AI occupies a slot', () => {
    const snapshot = makeSnapshot({
      phase: 'finished',
      slots: {
        p1: { claimed: true, name: 'AI', connected: true, controller: 'ai' },
        p2: { claimed: true, name: 'Bravo', connected: true, controller: 'human' },
      },
    });

    expect(getWinnerLabel({ winner: 'p1', reason: 'resign', forfeitSlot: null }, snapshot)).toBe('AI Wins by Resignation');
  });

  it('does not render the gameplay connection card in the live HUD', () => {
    const markup = renderGameplayHud(makeLiveSnapshot());

    expect(markup).not.toContain('data-testid="connection-card"');
  });

  it('renders the three live HUD cards during countdown', () => {
    const markup = renderGameplayHud(makeLiveSnapshot({
      phase: 'countdown',
      game: {
        board: { width: BOARD_WIDTH, height: BOARD_HEIGHT },
        remainingMs: 90_000,
        countdownMs: 2_400,
        food: { x: 8, y: 8 },
        players: {
          p1: {
            alive: true,
            score: 0,
            direction: 'right',
            length: 1,
            segments: [{ x: 2, y: 2 }],
            respawnRemainingMs: 0,
            respawnPreview: null,
          },
          p2: {
            alive: true,
            score: 0,
            direction: 'left',
            length: 1,
            segments: [{ x: 10, y: 10 }],
            respawnRemainingMs: 0,
            respawnPreview: null,
          },
        },
      },
    }));

    expect(markup).toContain('data-testid="timer-card"');
    expect(markup).toContain('data-testid="p1-score-card"');
    expect(markup).toContain('data-testid="p2-score-card"');
    expect(markup).not.toContain('Player One');
    expect(markup).not.toContain('Player Two');
    expect(markup).not.toContain('Round Timer');
    expect(markup).not.toContain('Match Active');
    expect(markup).not.toContain('Score');
    expect(markup).not.toContain('Re-entry in');
  });

  it('keeps resign trigger and confirmation controls inside the live HUD cards', () => {
    const liveMarkup = renderGameplayHud(makeLiveSnapshot());
    expect(liveMarkup).toContain('data-testid="resign-trigger-p1"');
    expect(liveMarkup).not.toContain('data-testid="resign-confirmation-p1"');
    expect(liveMarkup).toContain('>12<');
    expect(liveMarkup).not.toContain('>Score<');

    const confirmMarkup = renderGameplayHud(makeLiveSnapshot({
      game: {
        board: { width: BOARD_WIDTH, height: BOARD_HEIGHT },
        remainingMs: 41_000,
        countdownMs: 0,
        food: { x: 8, y: 8 },
        players: {
          p1: {
            alive: false,
            score: 7,
            direction: 'right',
            length: 1,
            segments: [{ x: 2, y: 2 }],
            respawnRemainingMs: 2_000,
            respawnPreview: null,
          },
          p2: {
            alive: true,
            score: 12,
            direction: 'left',
            length: 1,
            segments: [{ x: 10, y: 10 }],
            respawnRemainingMs: 0,
            respawnPreview: null,
          },
        },
      },
    }), 'p1');

    expect(confirmMarkup).toContain('data-testid="resign-confirmation-p1"');
    expect(confirmMarkup).toContain('data-testid="resign-confirm-p1"');
    expect(confirmMarkup).toContain('data-testid="resign-cancel-p1"');
    expect(confirmMarkup).toContain('Respawning 2');
    expect(confirmMarkup).not.toContain('Respawn 2');
  });
});
