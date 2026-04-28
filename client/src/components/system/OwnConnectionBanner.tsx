/**
 * Shows the player THEIR OWN socket connection status.
 *
 * socket.io's reconnect lifecycle (events live on `socket.io`, the
 * Manager — NOT the Socket itself):
 *   - reconnect_attempt  : retrying — we count attempts to escalate UI
 *   - reconnect          : restored
 *   - reconnect_failed   : retries exhausted, terminal — show "please refresh"
 *
 * Plus the per-Socket events:
 *   - connect            : healthy
 *   - disconnect         : transport dropped, reconnect loop will start
 *
 * UX rules:
 *   - We intentionally do NOT show a banner during the first 2 seconds
 *     of a `disconnect` — wifi blips happen all the time and a flashing
 *     banner is more annoying than informative.
 *   - After 2s without recovery we surface "Reconnecting…" (warn).
 *   - After 10s of attempts (or many attempts) we escalate to "Still
 *     trying to reconnect…" (danger).
 *   - On `reconnect_failed` we lock into the terminal "Disconnected —
 *     please refresh" state. The user has to manually reload; auto-
 *     retry has given up.
 */

import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { useLanguage } from "@/context/LanguageContext";

interface OwnConnectionBannerProps {
  socket: Socket | null;
}

type Phase = "ok" | "warn" | "danger" | "restored" | "terminal";

export function OwnConnectionBanner({ socket }: OwnConnectionBannerProps) {
  const { t } = useLanguage();
  const [phase, setPhase] = useState<Phase>("ok");

  useEffect(() => {
    if (!socket) return;
    let warnTimeout: ReturnType<typeof setTimeout> | null = null;
    let dangerTimeout: ReturnType<typeof setTimeout> | null = null;
    let restoreTimeout: ReturnType<typeof setTimeout> | null = null;

    const clearAll = () => {
      if (warnTimeout) clearTimeout(warnTimeout);
      if (dangerTimeout) clearTimeout(dangerTimeout);
      warnTimeout = null;
      dangerTimeout = null;
    };

    const onDisconnect = () => {
      clearAll();
      // Suppress for the first 2s — most blips recover before we'd render.
      warnTimeout = setTimeout(() => {
        setPhase((p) => (p === "terminal" ? p : "warn"));
      }, 2000);
      dangerTimeout = setTimeout(() => {
        setPhase((p) => (p === "terminal" ? p : "danger"));
      }, 10000);
    };
    const onConnect = () => {
      clearAll();
      // `phase` may be stale here (we don't list it in deps); use the
      // updater form so we transition correctly from any non-ok state.
      setPhase((p) => {
        if (p === "warn" || p === "danger") {
          if (restoreTimeout) clearTimeout(restoreTimeout);
          restoreTimeout = setTimeout(() => setPhase("ok"), 3000);
          return "restored";
        }
        if (p === "terminal") return p; // user must refresh manually
        return "ok";
      });
    };
    const onReconnectAttempt = (attempt: number) => {
      // Escalate to danger after a handful of attempts even if 10s
      // hasn't elapsed (e.g. the manager backs off and tries fast).
      if (attempt >= 3) {
        setPhase((p) => (p === "ok" || p === "warn" ? "danger" : p));
      } else {
        setPhase((p) => (p === "ok" ? "warn" : p));
      }
    };
    const onReconnectFailed = () => {
      clearAll();
      setPhase("terminal");
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    // Manager-level lifecycle. socket.io exposes `socket.io` as the
    // Manager. It is the source of truth for retry exhaustion.
    socket.io.on("reconnect_attempt", onReconnectAttempt);
    socket.io.on("reconnect_failed", onReconnectFailed);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.io.off("reconnect_attempt", onReconnectAttempt);
      socket.io.off("reconnect_failed", onReconnectFailed);
      clearAll();
      if (restoreTimeout) clearTimeout(restoreTimeout);
    };
  }, [socket]);

  if (phase === "ok") return null;
  if (phase === "restored") {
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100" data-testid="banner-own-restored">
        {t("Connection restored.", "Connection restored.")}
      </div>
    );
  }
  if (phase === "terminal") {
    return (
      <div
        className="rounded-md border border-red-600/60 bg-red-600/15 px-3 py-2 text-sm text-red-100 font-semibold"
        data-testid="banner-own-terminal"
        role="alert"
      >
        {t("Disconnected — please refresh.", "Disconnected — please refresh.")}
      </div>
    );
  }
  const isDanger = phase === "danger";
  return (
    <div
      className={
        "rounded-md px-3 py-2 text-sm border " +
        (isDanger
          ? "border-red-500/40 bg-red-500/10 text-red-100"
          : "border-amber-500/40 bg-amber-500/10 text-amber-100")
      }
      data-testid={isDanger ? "banner-own-danger" : "banner-own-warn"}
    >
      {isDanger
        ? t("Still trying to reconnect…", "Still trying to reconnect…")
        : t("Reconnecting…", "Reconnecting…")}
    </div>
  );
}
