/**
 * Shows the player THEIR OWN socket connection status.
 *
 * socket.io's reconnect lifecycle:
 *   - connect       : healthy
 *   - disconnect    : transport dropped, attempting reconnect
 *   - reconnect_attempt : retrying (we count attempts)
 *   - reconnect     : restored
 *
 * We intentionally do NOT show a banner during the first 2 seconds of
 * a `disconnect` — wifi blips happen all the time and a flashing
 * banner is more annoying than informative. After 2s without recovery
 * we surface the warning; after 10s we escalate it to "still trying".
 */

import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { useLanguage } from "@/context/LanguageContext";

interface OwnConnectionBannerProps {
  socket: Socket | null;
}

type Phase = "ok" | "warn" | "danger" | "restored";

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
      warnTimeout = setTimeout(() => setPhase("warn"), 2000);
      dangerTimeout = setTimeout(() => setPhase("danger"), 10000);
    };
    const onConnect = () => {
      const wasDown = phase === "warn" || phase === "danger";
      clearAll();
      if (wasDown) {
        setPhase("restored");
        restoreTimeout = setTimeout(() => setPhase("ok"), 3000);
      } else {
        setPhase("ok");
      }
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      clearAll();
      if (restoreTimeout) clearTimeout(restoreTimeout);
    };
  }, [socket, phase]);

  if (phase === "ok") return null;
  if (phase === "restored") {
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100" data-testid="banner-own-restored">
        {t("Connection restored.", "Connection restored.")}
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
