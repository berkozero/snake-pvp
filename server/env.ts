type ServerEnv = {
  host: string;
  port: number;
  tickMs: number;
  movementMs: number;
  countdownMs: number;
  matchDurationMs: number;
  livenessTimeoutMs: number;
  disconnectGraceMs: number;
  finishDwellMs: number;
  rateLimitPerSecond: number;
};

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected a positive number`);
  }

  return value;
}

export function readServerEnv(): ServerEnv {
  const host = process.env.HOST?.trim() || '0.0.0.0';

  return {
    host,
    port: readNumber('PORT', 3001),
    tickMs: readNumber('SERVER_TICK_MS', 50),
    movementMs: readNumber('SERVER_MOVEMENT_MS', 100),
    countdownMs: readNumber('COUNTDOWN_MS', 2_400),
    matchDurationMs: readNumber('MATCH_DURATION_MS', 90_000),
    livenessTimeoutMs: readNumber('LIVENESS_TIMEOUT_MS', 5_000),
    disconnectGraceMs: readNumber('DISCONNECT_GRACE_MS', 3_000),
    finishDwellMs: readNumber('FINISH_DWELL_MS', 6_000),
    rateLimitPerSecond: readNumber('RATE_LIMIT_PER_SECOND', 40),
  };
}
