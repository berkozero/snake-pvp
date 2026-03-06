const DEFAULT_LOCAL_GAME_SERVER_URL = 'ws://127.0.0.1:3001/ws';

export function getGameServerUrl(): string {
  const configured = import.meta.env.VITE_GAME_SERVER_URL?.trim();
  if (!configured) {
    return DEFAULT_LOCAL_GAME_SERVER_URL;
  }

  try {
    const url = new URL(configured);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      return configured;
    }
  } catch {
    // Fall through to the error below.
  }

  throw new Error('VITE_GAME_SERVER_URL must use ws:// or wss://');
}
