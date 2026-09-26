import { envOptional } from "./env";
import { pushCopierConfig } from "./copier-client";

/**
 * Push the copier configuration once the web app is up.
 *
 * The copier service keeps no configuration of its own: it learns about
 * accounts and links only from us. Without this, a copier restarted on its own
 * — a service restart, a crash, a reboot — would come back knowing nothing and
 * silently copy nothing, with the Copier page showing links that look armed.
 *
 * Retried with a growing delay because on a cold boot the web app is usually
 * ready before the copier is, and it is skipped entirely when no copier secret
 * is configured, so an install that does not copy trades stays untouched.
 *
 * It then keeps re-pushing on a slow timer. That is what makes a copier
 * restart self-healing: the service comes back empty, and without this it
 * would sit idle until somebody happened to save something in the UI. The push
 * is idempotent — unchanged accounts keep their running workers, and link
 * state lives in the copier's own state file — so repeating it costs nothing.
 */
const RETRY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000, 120_000];
const RESYNC_INTERVAL_MS = 60_000;

declare global {
  var __mt5_copier_sync_started__: boolean | undefined;
  var __mt5_copier_sync_timer__: ReturnType<typeof setInterval> | undefined;
}

export function startCopierConfigSync(): void {
  if (globalThis.__mt5_copier_sync_started__) return;
  if (!envOptional("MT5_COPIER_SECRET", envOptional("COPIER_SECRET"))) return;
  globalThis.__mt5_copier_sync_started__ = true;

  let attempt = 0;
  let lastSummary = "";
  const tryPush = async () => {
    try {
      const result = await pushCopierConfig();
      attempt = 0;
      const summary =
        `${result.accounts} account(s), ${result.links} link(s)` +
        (result.problems.length ? `, ${result.problems.length} rejected` : "");
      // Only announce a change, so the slow re-push does not fill the log.
      if (summary !== lastSummary) {
        lastSummary = summary;
        console.log(`[copier] configuration pushed: ${summary}`);
        for (const problem of result.problems) console.error(`[copier] ${problem}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
      attempt += 1;
      lastSummary = "";
      console.error(
        `[copier] could not push configuration (${message}); retrying in ${delay / 1000}s`,
      );
      setTimeout(() => void tryPush(), delay).unref?.();
    }
  };

  // Let the rest of the boot finish first; the copier is usually still starting.
  setTimeout(() => void tryPush(), 1_500).unref?.();

  if (globalThis.__mt5_copier_sync_timer__) clearInterval(globalThis.__mt5_copier_sync_timer__);
  const timer = setInterval(() => void tryPush(), RESYNC_INTERVAL_MS);
  timer.unref?.();
  globalThis.__mt5_copier_sync_timer__ = timer;
}
