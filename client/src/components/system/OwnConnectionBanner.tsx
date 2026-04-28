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
    let dangerTimeout: ReturnType<typeof setTimeout> | null = null;
    let restoreTimeout: ReturnType<typeof setTimeout> | null = null;

    const onDisconnect = () => {
      if (dangerTimeout) clearTimeout(dangerTimeout);
      // Show "Reconnecting…" immediately. Escalate to "Still trying…"
      // after 10s if we haven't recovered.
      setPhase((p) => (p === "terminal" ? p : "warn"));
      dangerTimeout = setTimeout(() => {
        setPhase((p) => (p === "terminal" ? p : "danger"));
      }, 10000);
    };
    const onConnect = () => {
      if (dangerTimeout) clearTimeout(dangerTimeout);
      dangerTimeout = null;
      setPhase((p) => {
        if (p === "warn" || p === "danger") {
          if (restoreTimeout) clearTimeout(restoreTimeout);
          restoreTimeout = setTimeout(() => setPhase("ok"), 3000);
          return "restored";
        }
        if (p === "terminal") return p;
        return "ok";
      });
    };
    const onReconnectAttempt = (attempt: number) => {
      if (attempt >= 3) {
        setPhase((p) => (p === "ok" || p === "warn" ? "danger" : p));
      } else {
        setPhase((p) => (p === "ok" ? "warn" : p));
      }
    };
    const onReconnectFailed = () => {
      if (dangerTimeout) clearTimeout(dangerTimeout);
      setPhase("terminal");
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.io.on("reconnect_attempt", onReconnectAttempt);
    socket.io.on("reconnect_failed", onReconnectFailed);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.io.off("reconnect_attempt", onReconnectAttempt);
      socket.io.off("reconnect_failed", onReconnectFailed);
      if (dangerTimeout) clearTimeout(dangerTimeout);
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
