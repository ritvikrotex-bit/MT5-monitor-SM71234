export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing environment variable ${name}.`);
  }
  return value;
}

export function envOptional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const connectorUrl = () =>
  envOptional("MT5_CONNECTOR_URL", "http://127.0.0.1:8765").replace(/\/$/, "");

// No built-in default: a missing secret must fail loudly rather than fall back to a known value.
export const connectorSecret = () => env("MT5_CONNECTOR_SECRET", envOptional("CONNECTOR_SECRET"));

const DEFAULT_POLL_SECONDS = 5;

export function monitorPollIntervalMs(): number {
  const envVal = envOptional(
    "MT5_MONITOR_INTERVAL_SECONDS",
    envOptional("MONITOR_POLL_INTERVAL_SECONDS", String(DEFAULT_POLL_SECONDS)),
  );
  const seconds = Number.parseInt(envVal, 10);
  return (
    Math.min(300, Math.max(1, Number.isFinite(seconds) ? seconds : DEFAULT_POLL_SECONDS)) * 1_000
  );
}
