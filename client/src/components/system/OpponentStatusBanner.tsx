/**
 * Shared banner mounted inside every game shell (Chess, Tetris,
 * Checkers, Battleship). Listens for the three opponent-state events
 * the server emits during a match:
 *
 *   - opponent-disconnect-pending : opponent dropped, server is giving
 *     them `secondsRemaining` to reconnect before forfeiting.
 *   - opponent-reconnected        : opponent came back; clear the warning.
 *   - opponent-disconnected       : terminal — opponent is forfeited
 *     and a `game-result` is incoming. We show a brief confirmation
 *     so the player understands WHY the result modal is about to pop.
 *
 * Tailwind-only; no extra deps. Sits above the board, fixed position
 * relative to the game shell so layout doesn't jump.
 */

import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { useLanguage } from "@/context/LanguageContext";

interface DisconnectPending {
  // Absolute unix-ms deadline by which the opponent must reconnect.
  // The server emits `graceUntilMs` (Date.now() + grace_window) — we
  // use it directly so the countdown does not drift if the user's
  // wall-clock disagrees with the server's by a few hundred ms.
  graceUntilMs: number;
}

interface OpponentStatusBannerProps {
  socket: Socket | null;
  matchId?: string;
}

export function OpponentStatusBanner({ socket }: OpponentStatusBannerProps) {
  const { t } = useLanguage();
  const [pending, setPending] = useState<DisconnectPending | null>(null);
  const [forfeited, setForfeited] = useState(false);
  const [reconnectedAt, setReconnectedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!socket) return;
    const onPending = (payload: { graceUntilMs?: number; secondsRemaining?: number }) => {
      // The server emits `graceUntilMs` (absolute deadline). Older
      // clients used to expect `secondsRemaining` — we tolerate both
      // so a partial deploy can't break the banner.
      const deadline =
        typeof payload?.graceUntilMs === "number"
          ? payload.graceUntilMs
          : Date.now() + Math.max(0, payload?.secondsRemaining ?? 30) * 1000;
      setForfeited(false);
      setReconnectedAt(null);
      setPending({ graceUntilMs: deadline });
    };
    const onReconnected = () => {
      setPending(null);
      setForfeited(false);
      setReconnectedAt(Date.now());
    };
    const onDisconnected = () => {
      setPending(null);
      setForfeited(true);
    };

    socket.on("opponent-disconnect-pending", onPending);
    socket.on("opponent-reconnected", onReconnected);
    socket.on("opponent-disconnected", onDisconnected);
    return () => {
      socket.off("opponent-disconnect-pending", onPending);
      socket.off("opponent-reconnected", onReconnected);
      socket.off("opponent-disconnected", onDisconnected);
    };
  }, [socket]);

  // Tick the live countdown every second while pending.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!pending) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [pending]);

  // Auto-dismiss the "reconnected" toast after 4s.
  useEffect(() => {
    if (!reconnectedAt) return;
    const timeout = setTimeout(() => setReconnectedAt(null), 4000);
    return () => clearTimeout(timeout);
  }, [reconnectedAt]);

  if (forfeited) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100" data-testid="banner-opponent-forfeited">
        {t("Opponent forfeited (connection lost).", "Opponent forfeited (connection lost).")}
      </div>
    );
  }
  if (pending) {
    const remaining = Math.max(0, Math.ceil((pending.graceUntilMs - now) / 1000));
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100" data-testid="banner-opponent-disconnect-pending">
        {t("Opponent disconnected. Forfeit in", "Opponent disconnected. Forfeit in")}{" "}
        <span className="font-mono font-semibold">{remaining}s</span>
      </div>
    );
  }
  if (reconnectedAt) {
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100" data-testid="banner-opponent-reconnected">
        {t("Opponent reconnected.", "Opponent reconnected.")}
      </div>
    );
  }
  return null;
}
