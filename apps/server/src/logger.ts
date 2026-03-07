type LogContext = Record<string, string | number | boolean | null | undefined>;

export function logEvent(event: string, context: LogContext = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...context,
  };
  console.log(JSON.stringify(payload));
}
