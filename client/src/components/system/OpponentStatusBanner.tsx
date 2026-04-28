import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { useLanguage } from "@/context/LanguageContext";
import { useToast } from "@/hooks/use-toast";

interface DisconnectPending {
  graceUntilMs: number;
}

interface OpponentStatusBannerProps {
  socket: Socket | null;
  matchId?: string;
}

export function OpponentStatusBanner({ socket }: OpponentStatusBannerProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [pending, setPending] = useState<DisconnectPending | null>(null);
  const [forfeited, setForfeited] = useState(false);

  useEffect(() => {
    if (!socket) return;
    const onPending = (payload: { graceUntilMs?: number; secondsRemaining?: number }) => {
      const deadline =
        typeof payload?.graceUntilMs === "number"
          ? payload.graceUntilMs
          : Date.now() + Math.max(0, payload?.secondsRemaining ?? 30) * 1000;
      setForfeited(false);
      setPending({ graceUntilMs: deadline });
    };
    const onReconnected = () => {
      setPending((prev) => {
        if (prev) {
          toast({
            title: t("Opponent reconnected", "Opponent reconnected"),
            description: t("The match continues.", "The match continues."),
            duration: 3000,
          });
        }
        return null;
      });
      setForfeited(false);
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
  }, [socket, toast, t]);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!pending) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [pending]);

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
  return null;
}
