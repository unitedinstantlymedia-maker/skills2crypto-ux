/**
 * Lightweight ops alerting hub.
 *
 * Routes critical operational events (low TRX balance, DB↔chain
 * reconciliation drift, kill-switch toggles) to:
 *   1. console.error LOUD (always — visible in workflow logs)
 *   2. POST JSON to OPS_ALERT_WEBHOOK (Slack-incoming-webhook
 *      compatible; any URL accepting POST application/json works)
 *
 * Hysteresis is built in: the same `key` will only re-alert at most
 * once per ALERT_REFIRE_MS window. This prevents log/Slack spam when
 * a condition (e.g. low TRX) persists across many minutes of polling.
 */

const ALERT_REFIRE_MS = 30 * 60_000; // 30 min
const lastFiredAt = new Map<string, number>();

export type AlertSeverity = "info" | "warn" | "critical";

export interface OpsAlert {
  key: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  context?: Record<string, unknown>;
}

let _webhookFailures = 0;

async function postWebhook(alert: OpsAlert): Promise<void> {
  const url = process.env.OPS_ALERT_WEBHOOK;
  if (!url) return;
  try {
    // Slack-compatible payload: also include the raw object so non-Slack
    // sinks (Discord, ntfy.sh, custom) get full context.
    const text = `*[${alert.severity.toUpperCase()}] ${alert.title}*\n${alert.message}`;
    const body = JSON.stringify({
      text,
      severity: alert.severity,
      key: alert.key,
      title: alert.title,
      message: alert.message,
      context: alert.context ?? {},
      timestamp: new Date().toISOString(),
    });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      _webhookFailures += 1;
      console.warn(
        `[opsAlert] webhook returned ${res.status} (failures so far: ${_webhookFailures})`
      );
    } else {
      _webhookFailures = 0;
    }
  } catch (e: any) {
    _webhookFailures += 1;
    console.warn(
      `[opsAlert] webhook POST failed: ${e?.message || e} (failures so far: ${_webhookFailures})`
    );
  }
}

export function fireOpsAlert(alert: OpsAlert): void {
  const now = Date.now();
  const last = lastFiredAt.get(alert.key) || 0;
  if (now - last < ALERT_REFIRE_MS) return;
  lastFiredAt.set(alert.key, now);

  const ctxStr = alert.context ? ` ${JSON.stringify(alert.context)}` : "";
  const line = `[ALERT:${alert.severity}] ${alert.key} — ${alert.title}: ${alert.message}${ctxStr}`;
  if (alert.severity === "critical" || alert.severity === "warn") {
    console.error(line);
  } else {
    console.warn(line);
  }
  // fire-and-forget the webhook
  postWebhook(alert).catch(() => {});
}

/**
 * Reset the hysteresis for a given alert key when the underlying
 * condition is observed to clear. Lets us re-alert promptly if the
 * condition recurs within the refire window.
 */
export function clearOpsAlert(key: string): void {
  lastFiredAt.delete(key);
}

export function getOpsAlertStatus() {
  return {
    webhookConfigured: Boolean(process.env.OPS_ALERT_WEBHOOK),
    webhookFailuresInARow: _webhookFailures,
    activeKeys: Array.from(lastFiredAt.keys()),
  };
}
