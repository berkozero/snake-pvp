import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@snake/game-core/protocol';
import { DEFAULT_MATCH_DURATION_MS, createRoomForTests } from './room';
const AUTHORITATIVE_TICK_MS = 50;
const TEST_AI_POLICY = {
  metadata: {
    runId: 'test-ai',
    modelType: 'stub',
    inputSize: 44,
    hiddenSize: 32,
    hiddenSizes: [32, 32],
    outputSize: 5,
    actionOrder: ['up', 'down', 'left', 'right', 'stay'],
    observationVersion: 2,
    exportVersion: 'rl-policy-v1',
  },
  selectAction() {
    return 'up' as const;
  },
};

function createHarness(options: Parameters<typeof createRoomForTests>[0] = {}) {
  let now = 1_000;
  const sent = new Map<string, ServerMessage[]>();
  const logs: Array<{ event: string; context: Record<string, unknown> | undefined }> = [];
  const room = createRoomForTests({
    ...options,
    now: () => now,
    emitToSession: (socketId, message) => {
      sent.set(socketId, [...(sent.get(socketId) ?? []), message]);
    },
    log: (event, context) => {
      logs.push({ event, context });
    },
  });

  const connect = (socketId: string) => {
    room.connect(socketId);
    return socketId;
  };

  const send = (socketId: string, payload: Record<string, unknown>) => {
    room.handleMessage(
      socketId,
      JSON.stringify({
        v: 1,
        roomId: 'main',
        roundId: room.roundId,
        ...payload,
      }),
    );
  };

  const latest = (socketId: string) => {
    const messages = sent.get(socketId) ?? [];
    return messages.at(-1);
  };

  const advance = (ms: number) => {
    const steps = Math.ceil(ms / AUTHORITATIVE_TICK_MS);
    for (let index = 0; index < steps; index += 1) {
      now += AUTHORITATIVE_TICK_MS;
      room.tick();
    }
  };

  const tickOnce = (ms = AUTHORITATIVE_TICK_MS) => {
    now += ms;
    room.tick();
  };

  return { room, sent, logs, connect, send, latest, advance, tickOnce, getNow: () => now, setNow: (value: number) => { now = value; } };
}

describe('MainRoom', () => {
  it('joins open slots and rejects duplicate names case-insensitively', () => {
    const { connect, send, latest } = createHarness();

    connect('s1');
    connect('s2');

    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'alpha' });

    const rejection = latest('s2');
    expect(rejection?.type).toBe('join_rejected');
    if (rejection?.type === 'join_rejected') {
      expect(rejection.reason).toBe('duplicate_name');
    }
  });

  it('rejects joins in locked phases and while a slot is grace-reserved', () => {
    const { room, connect, send, latest } = createHarness();

    connect('s1');
    connect('s2');
    connect('s3');

    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' });
    send('s1', { type: 'start_match', requestId: 'c' });
    send('s3', { type: 'join_slot', requestId: 'd', slot: 'p1', name: 'Charlie' });

    const locked = latest('s3');
    expect(locked?.type).toBe('join_rejected');
    if (locked?.type === 'join_rejected') {
      expect(locked.reason).toBe('room_locked');
    }

    room.disconnect('s2');
    send('s3', { type: 'join_slot', requestId: 'e', slot: 'p2', name: 'Charlie' });

    const reserved = latest('s3');
    expect(reserved?.type).toBe('join_rejected');
    if (reserved?.type === 'join_rejected') {
      expect(reserved.reason).toBe('slot_reserved');
    }
  });

  it('frees a reserved lobby slot after grace expiry', () => {
    const { room, connect, send, advance } = createHarness();

    connect('s1');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });

    room.disconnect('s1');
    expect(room.phase).toBe('waiting');

    advance(3_100);

    expect(room.phase).toBe('empty');
    expect(room.slots.p1.ownerSessionId).toBeNull();
  });

  it('restores a disconnected player session during the grace window', () => {
    const { room, connect, send, latest } = createHarness();

    connect('s1');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    const claimed = latest('s1');
    expect(claimed?.type).toBe('room_snapshot');
    const resumeToken = claimed?.type === 'room_snapshot' ? claimed.resumeToken : null;
    expect(resumeToken).toBeTruthy();

    room.disconnect('s1');
    connect('s2');
    send('s2', { type: 'resume_session', requestId: 'b', resumeToken });

    const restored = latest('s2');
    expect(restored?.type).toBe('room_snapshot');
    if (restored?.type === 'room_snapshot') {
      expect(restored.yourSlot).toBe('p1');
      expect(restored.resumeToken).toBe(resumeToken);
    }
    expect(room.slots.p1.connected).toBe(true);
  });

  it('downgrades ready to waiting and cancels countdown on disconnect', () => {
    const { room, connect, send } = createHarness();

    connect('s1');
    connect('s2');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' });
    expect(room.phase).toBe('ready');

    room.disconnect('s2');
    expect(room.phase).toBe('waiting');

    const countdown = createHarness();
    countdown.connect('c1');
    countdown.connect('c2');
    countdown.send('c1', { type: 'join_slot', requestId: 'c', slot: 'p1', name: 'Alpha2' });
    countdown.send('c2', { type: 'join_slot', requestId: 'd', slot: 'p2', name: 'Bravo2' });
    countdown.send('c1', { type: 'start_match', requestId: 'e' });
    expect(countdown.room.phase).toBe('countdown');

    countdown.room.disconnect('c2');
    expect(countdown.room.phase).toBe('waiting');
    expect(countdown.room.roundId).toBeNull();
  });

  it('accepts start only when both slots are claimed and connected', () => {
    const { room, connect, send, latest } = createHarness();

    connect('s1');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s1', { type: 'start_match', requestId: 'b' });

    const rejected = latest('s1');
    expect(rejected?.type).toBe('action_rejected');
    expect(room.phase).toBe('waiting');
  });

  it('lets a human fill the opposite slot with AI and remove it before start', () => {
    const { room, connect, send, latest } = createHarness({ aiPolicy: TEST_AI_POLICY });

    connect('s1');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s1', { type: 'set_ai_slot', requestId: 'b', slot: 'p2', enabled: true });

    expect(room.phase).toBe('ready');
    expect(room.slots.p2.controller).toBe('ai');
    const afterAdd = latest('s1');
    expect(afterAdd?.type).toBe('room_snapshot');
    if (afterAdd?.type === 'room_snapshot') {
      expect(afterAdd.slots.p2.controller).toBe('ai');
      expect(afterAdd.slots.p2.name).toBe('Pluribus');
    }

    send('s1', { type: 'set_ai_slot', requestId: 'c', slot: 'p2', enabled: false });
    expect(room.phase).toBe('waiting');
    expect(room.slots.p2.controller).toBe('none');
  });

  it('lets a connected viewer add and remove AI slots before any human joins', () => {
    const { room, connect, send, latest } = createHarness({ aiPolicy: TEST_AI_POLICY });

    connect('viewer');
    send('viewer', { type: 'set_ai_slot', requestId: 'a', slot: 'p1', enabled: true });
    expect(room.slots.p1.controller).toBe('ai');
    expect(room.slots.p1.name).toBe('Pluribus');

    send('viewer', { type: 'set_ai_slot', requestId: 'b', slot: 'p1', enabled: false });
    expect(room.slots.p1.controller).toBe('none');
  });

  it('rejects AI slot changes when a human tries to modify their own slot', () => {
    const { room, connect, send, latest } = createHarness({ aiPolicy: TEST_AI_POLICY });

    connect('s1');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s1', { type: 'set_ai_slot', requestId: 'b', slot: 'p1', enabled: true });
    const sameSlot = latest('s1');
    expect(sameSlot?.type).toBe('action_rejected');
    if (sameSlot?.type === 'action_rejected') {
      expect(sameSlot.reason).toBe('invalid_phase');
    }
    expect(room.slots.p1.controller).toBe('human');
  });

  it('lets a connected viewer start a ready AI-only room', () => {
    const { room, connect, send, advance } = createHarness({ aiPolicy: TEST_AI_POLICY });

    connect('viewer');
    send('viewer', { type: 'set_ai_slot', requestId: 'a', slot: 'p1', enabled: true });
    send('viewer', { type: 'set_ai_slot', requestId: 'b', slot: 'p2', enabled: true });

    expect(room.phase).toBe('ready');

    send('viewer', { type: 'start_match', requestId: 'c' });
    advance(2_400);

    expect(room.phase).toBe('playing');
  });

  it('starts a human-vs-ai match and lets the bot submit server-side turns', () => {
    const { room, connect, send, advance } = createHarness({ aiPolicy: TEST_AI_POLICY });

    connect('s1');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s1', { type: 'set_ai_slot', requestId: 'b', slot: 'p2', enabled: true });
    send('s1', { type: 'start_match', requestId: 'c' });

    advance(2_400);
    expect(room.phase).toBe('playing');
    expect(room.game?.players.p2.pendingDirection).toBe('up');

    advance(100);
    expect(room.game?.players.p2.direction).toBe('up');
    expect(room.game?.players.p2.segments[0]).toEqual({ x: 27, y: 11 });
  });

  it('keeps roundId stable through finish and resets it after dwell', () => {
    const { room, connect, send, advance, tickOnce } = createHarness();

    connect('s1');
    connect('s2');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' });
    send('s1', { type: 'start_match', requestId: 'c' });

    const roundId = room.roundId;
    expect(roundId).not.toBeNull();

    if (room.game) {
      room.game = { ...room.game, phase: 'playing', countdownMs: 0, remainingMs: 100 };
      room.phase = 'playing';
    }

    tickOnce();
    tickOnce();
    expect(room.phase).toBe('finished');
    expect(room.roundId).toBe(roundId);

    advance(6_100);
    expect(room.phase).toBe('empty');
    expect(room.roundId).toBeNull();
    expect(room.tickSeq).toBe(0);
  });

  it('increments tickSeq only when a movement step advances board state and sends an immediate snapshot on accepted start', () => {
    const { room, connect, send, latest, tickOnce } = createHarness();

    connect('s1');
    connect('s2');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' });
    send('s1', { type: 'start_match', requestId: 'c' });

    const startSnapshot = latest('s1');
    expect(startSnapshot?.type).toBe('room_snapshot');
    if (startSnapshot?.type === 'room_snapshot') {
      expect(startSnapshot.phase).toBe('countdown');
      expect(startSnapshot.tickSeq).toBe(0);
      expect(startSnapshot.roundId).not.toBeNull();
    }

    tickOnce();
    expect(room.tickSeq).toBe(0);

    if (room.game) {
      room.game = { ...room.game, phase: 'playing', countdownMs: 0 };
      room.phase = 'playing';
    }

    tickOnce();
    expect(room.tickSeq).toBe(0);

    tickOnce();
    expect(room.tickSeq).toBe(1);
  });

  it('ignores malformed messages and logs them', () => {
    const { room, connect, logs } = createHarness();

    connect('s1');
    room.handleMessage('s1', '{bad json');
    room.handleMessage('s1', JSON.stringify({ v: 99, roomId: 'main', type: 'ping' }));

    expect(logs.some((entry) => entry.event === 'message_ignored')).toBe(true);
  });

  it('rejects stale round messages from an old round', () => {
    const { room, connect, send, sent, advance, tickOnce } = createHarness({ livenessTimeoutMs: 10_000 });

    connect('s1');
    connect('s2');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' });
    send('s1', { type: 'start_match', requestId: 'c' });
    const oldRoundId = room.roundId;

    if (room.game) {
      room.game = { ...room.game, phase: 'playing', countdownMs: 0, remainingMs: 100 };
      room.phase = 'playing';
    }
    tickOnce();
    tickOnce();
    advance(6_100);

    send('s1', { type: 'join_slot', requestId: 'd', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'e', slot: 'p2', name: 'Bravo' });
    send('s1', { type: 'start_match', requestId: 'f' });
    expect(room.roundId).not.toBe(oldRoundId);

    connect('s3');
    const before = sent.get('s1')?.length ?? 0;
    send('s1', { type: 'start_match', requestId: 'e', roundId: oldRoundId });

    const rejected = (sent.get('s1') ?? [])[before];
    expect(rejected?.type).toBe('action_rejected');
    if (rejected?.type === 'action_rejected') {
      expect(rejected.reason).toBe('invalid_phase');
    }
  });

  it('rejects stale input, rejects reversals, and keeps only the latest valid direction before tick', () => {
    const { room, connect, send, latest } = createHarness();

    connect('s1');
    connect('s2');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' });
    send('s1', { type: 'start_match', requestId: 'c' });

    send('s1', { type: 'input_direction', direction: 'up', inputSeq: 1, clientTime: 1 });
    send('s1', { type: 'input_direction', direction: 'down', inputSeq: 2, clientTime: 2 });
    send('s1', { type: 'input_direction', direction: 'left', inputSeq: 3, clientTime: 3 });
    send('s1', { type: 'input_direction', direction: 'left', inputSeq: 3, clientTime: 4 });

    expect(room.game?.players.p1.pendingDirection).toBe('down');

    const rejection = latest('s1');
    expect(rejection?.type).toBe('action_rejected');
    if (rejection?.type === 'action_rejected') {
      expect(['invalid_direction', 'stale_input']).toContain(rejection.reason);
    }

  });

  it('includes the same respawn preview in snapshots for both clients during the death window', () => {
    const { room, connect, send, latest, advance } = createHarness();

    connect('s1');
    connect('s2');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' });
    send('s1', { type: 'start_match', requestId: 'c' });

    if (room.game) {
      room.game = {
        ...room.game,
        phase: 'playing',
        countdownMs: 0,
        players: {
          ...room.game.players,
          p1: {
            ...room.game.players.p1,
            segments: [{ x: 35, y: 5 }, { x: 34, y: 5 }, { x: 33, y: 5 }, { x: 32, y: 5 }],
            direction: 'right',
            pendingDirection: 'right',
          },
        },
      };
      room.phase = 'playing';
    }

    advance(100);

    const p1Snapshot = latest('s1');
    const p2Snapshot = latest('s2');
    expect(p1Snapshot?.type).toBe('room_snapshot');
    expect(p2Snapshot?.type).toBe('room_snapshot');

    if (p1Snapshot?.type === 'room_snapshot' && p2Snapshot?.type === 'room_snapshot') {
      expect(p1Snapshot.game?.players.p1.alive).toBe(false);
      expect(p1Snapshot.game?.players.p1.respawnRemainingMs).toBeGreaterThan(0);
      expect(p1Snapshot.game?.players.p1.respawnPreview).toEqual(p2Snapshot.game?.players.p1.respawnPreview);
    }
  });

  it('accepts inputs on heartbeat ticks and applies the latest valid direction on the next movement step', () => {
    const { room, connect, send, advance } = createHarness();

    connect('s1');
    connect('s2');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' });
    send('s1', { type: 'start_match', requestId: 'c' });

    if (room.game) {
      room.game = {
        ...room.game,
        phase: 'playing',
        countdownMs: 0,
        players: {
          ...room.game.players,
          p1: {
            ...room.game.players.p1,
            segments: [{ x: 8, y: 12 }, { x: 7, y: 12 }, { x: 6, y: 12 }, { x: 5, y: 12 }],
            direction: 'right',
            pendingDirection: 'right',
          },
        },
      };
      room.phase = 'playing';
    }

    advance(50);
    send('s1', { type: 'input_direction', direction: 'up', inputSeq: 1, clientTime: 1 });
    send('s1', { type: 'input_direction', direction: 'left', inputSeq: 2, clientTime: 2 });

    expect(room.game?.players.p1.pendingDirection).toBe('up');
    expect(room.game?.players.p1.segments[0]).toEqual({ x: 8, y: 12 });

    advance(50);

    expect(room.game?.players.p1.direction).toBe('up');
    expect(room.game?.players.p1.segments[0]).toEqual({ x: 8, y: 11 });
    expect(room.tickSeq).toBe(1);
  });

  it('preserves elapsed remainder when countdown completes mid-heartbeat', () => {
    const { room, connect, send, tickOnce } = createHarness();

    connect('s1');
    connect('s2');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' });
    send('s1', { type: 'start_match', requestId: 'c' });

    if (room.game) {
      room.game = {
        ...room.game,
        countdownMs: 25,
        players: {
          ...room.game.players,
          p1: {
            ...room.game.players.p1,
            segments: [{ x: 8, y: 12 }, { x: 7, y: 12 }, { x: 6, y: 12 }, { x: 5, y: 12 }],
            direction: 'right',
            pendingDirection: 'right',
          },
        },
      };
    }

    tickOnce(125);

    expect(room.phase).toBe('playing');
    expect(room.game?.remainingMs).toBe(DEFAULT_MATCH_DURATION_MS - 100);
    expect(room.game?.players.p1.segments[0]).toEqual({ x: 9, y: 12 });
    expect(room.tickSeq).toBe(1);
  });

  it('finishes by forfeit after grace expiry during play and ignores disconnect branching during finished', () => {
    const { room, connect, send, advance } = createHarness();

    connect('s1');
    connect('s2');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' });
    send('s1', { type: 'start_match', requestId: 'c' });

    if (room.game) {
      room.game = { ...room.game, phase: 'playing', countdownMs: 0 };
      room.phase = 'playing';
    }

    room.disconnect('s2');
    expect(room.phase).toBe('playing');

    advance(3_100);
    expect(room.phase).toBe('finished');
    expect(room.result?.reason).toBe('forfeit');
    expect(room.result?.forfeitSlot).toBe('p2');

    room.disconnect('s1');
    expect(room.phase).toBe('finished');
  });

  it('cleans disconnected sessions after room reset', () => {
    const { room, connect, send, advance } = createHarness();

    connect('s1');
    connect('s2');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' });
    send('s1', { type: 'start_match', requestId: 'c' });

    if (room.game) {
      room.game = { ...room.game, phase: 'playing', countdownMs: 0 };
      room.phase = 'playing';
    }

    room.disconnect('s2');
    advance(3_100);
    expect(room.phase).toBe('finished');

    advance(6_100);
    expect(room.phase).toBe('empty');
    const disconnected = [...room.sessions.values()].filter((session) => !session.connected);
    expect(disconnected).toHaveLength(0);
  });

  it('runs a scripted match through the real room loop without changing live gameplay semantics', () => {
    const { room, connect, send, advance } = createHarness();

    connect('s1');
    connect('s2');
    send('s1', { type: 'join_slot', requestId: 'a', slot: 'p1', name: 'Alpha' });
    send('s2', { type: 'join_slot', requestId: 'b', slot: 'p2', name: 'Bravo' });
    send('s1', { type: 'start_match', requestId: 'c' });

    advance(2_400);
    expect(room.phase).toBe('playing');

    send('s1', { type: 'input_direction', direction: 'up', inputSeq: 1, clientTime: 1 });
    advance(100);
    send('s2', { type: 'input_direction', direction: 'down', inputSeq: 1, clientTime: 2 });
    advance(100);

    expect(room.game?.players.p1.direction).toBe('up');
    expect(room.game?.players.p2.direction).toBe('down');
    expect(room.game?.players.p1.segments[0]).toEqual({ x: 8, y: 10 });
    expect(room.game?.players.p2.segments[0]).toEqual({ x: 26, y: 13 });
    expect(room.tickSeq).toBeGreaterThanOrEqual(2);
  });
});
