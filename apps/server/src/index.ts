import { getDefaultRlPolicyPath, loadRlPolicy } from './ai/rlPolicy';
import { readServerEnv } from './env';
import { logEvent } from './logger';
import { MainRoom } from './room';

const env = readServerEnv();
const aiPolicy = await loadRlPolicy(env.aiPolicyPath || getDefaultRlPolicyPath());

const sockets = new Map<string, { send(message: string): void }>();
const room = new MainRoom({
  aiPolicy,
  tickMs: env.tickMs,
  movementMs: env.movementMs,
  countdownMs: env.countdownMs,
  matchDurationMs: env.matchDurationMs,
  livenessTimeoutMs: env.livenessTimeoutMs,
  disconnectGraceMs: env.disconnectGraceMs,
  finishDwellMs: env.finishDwellMs,
  rateLimitPerSecond: env.rateLimitPerSecond,
  emitToSession: (socketId, message) => {
    const socket = sockets.get(socketId);
    socket?.send(JSON.stringify(message));
  },
  log: logEvent,
});

const server = Bun.serve<{ socketId: string }>({
  hostname: env.host,
  port: env.port,
  fetch(request, serverRef) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        roomId: room.roomId,
        phase: room.phase,
        ts: Date.now(),
      });
    }

    if (url.pathname === '/ws') {
      const socketId = crypto.randomUUID();
      const upgraded = serverRef.upgrade(request, {
        data: { socketId },
      });

      if (upgraded) {
        return undefined;
      }

      return new Response('Upgrade failed', { status: 400 });
    }

    return new Response('Not found', { status: 404 });
  },
  websocket: {
    open(socket) {
      sockets.set(socket.data.socketId, socket);
      room.connect(socket.data.socketId);
    },
    message(socket, message) {
      if (typeof message !== 'string') {
        logEvent('message_ignored', { socketId: socket.data.socketId, reason: 'binary_message' });
        return;
      }

      room.handleMessage(socket.data.socketId, message);
    },
    close(socket) {
      sockets.delete(socket.data.socketId);
      room.disconnect(socket.data.socketId);
    },
  },
});

setInterval(() => {
  room.tick();
}, env.tickMs);

logEvent('server_started', {
  host: env.host,
  port: env.port,
  aiPolicyRunId: aiPolicy.metadata.runId,
  roomId: room.roomId,
  tickMs: env.tickMs,
  movementMs: env.movementMs,
});

console.log(`Snake PVP server listening on ws://${server.hostname}:${server.port}/ws`);
