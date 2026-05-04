import { motion } from "framer-motion";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";

import photorealisticChessImage from "@assets/generated_images/elegant_photorealistic_chess_pieces.png";
import cleanTetrisImage from "@assets/generated_images/clean_3d_colorful_tetris_blocks.png";
import photorealisticCheckersImage from "@assets/generated_images/classic_photorealistic_checkers_board.png";
import cinematicBattleshipImage from "@assets/generated_images/cinematic_realistic_battleship_game.png";
import elegantDominoesImage from "@assets/generated_images/elegant_photorealistic_dominoes.png";
import elegantXiangqiImage from "@assets/generated_images/elegant_photorealistic_xiangqi_board.png";

type DayCard = {
  day: string;
  name: string;
  image: string;
  active?: boolean;
};

const DAYS: DayCard[] = [
  { day: "Monday",    name: "Chess",      image: photorealisticChessImage },
  { day: "Tuesday",   name: "Tetris",     image: cleanTetrisImage },
  { day: "Wednesday", name: "Checkers",   image: photorealisticCheckersImage, active: true },
  { day: "Thursday",  name: "Battleship", image: cinematicBattleshipImage },
  { day: "Friday",    name: "Dominoes",   image: elegantDominoesImage },
  { day: "Saturday",  name: "Xiangqi",    image: elegantXiangqiImage },
];

export default function Tournaments() {
  return (
    <main className="relative w-full flex flex-col items-center gap-6">
      <Link href="/">
        <Button
          variant="ghost"
          size="sm"
          className="absolute -top-2 left-0 text-white/70 hover:text-white z-10"
          data-testid="button-back-home"
        >
          <ChevronLeft className="w-4 h-4 mr-1" />
          Back
        </Button>
      </Link>

      <motion.h1
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="font-display font-bold text-5xl uppercase tracking-widest text-center text-primary mt-6 leading-none"
        style={{
          textShadow:
            "0 0 14px rgba(0,255,136,0.95), 0 0 32px rgba(0,255,136,0.65), 0 0 56px rgba(0,255,136,0.35)",
        }}
        data-testid="text-tournaments-title"
      >
        Tournaments
      </motion.h1>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.15, duration: 0.5 }}
        className="font-display font-bold text-lg uppercase tracking-widest text-center leading-relaxed"
        style={{
          color: "#FFC83D",
          textShadow:
            "0 0 12px rgba(255,200,60,0.95), 0 0 26px rgba(255,180,40,0.6), 0 0 48px rgba(255,170,30,0.35)",
        }}
        data-testid="text-tournaments-tagline"
      >
        No KYC. Instant Payouts. Pure Skill.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25, duration: 0.5 }}
        className="w-full rounded-2xl border border-primary/40 bg-black/60 backdrop-blur-sm px-4 py-4"
        style={{
          boxShadow:
            "0 0 16px rgba(0,255,136,0.25), inset 0 0 22px rgba(0,255,136,0.08)",
        }}
        data-testid="card-countdown"
      >
        <div className="flex flex-col items-center gap-1">
          <div className="font-mono text-xs uppercase tracking-widest text-white/85">
            Next Tournament
          </div>
          <div
            className="font-display font-bold text-2xl uppercase tracking-widest text-primary"
            style={{
              textShadow:
                "0 0 12px rgba(0,255,136,0.9), 0 0 26px rgba(0,255,136,0.5)",
            }}
            data-testid="text-next-game"
          >
            Chess
          </div>
          <div
            className="font-mono font-bold text-5xl tracking-widest text-primary leading-none mt-1"
            style={{
              textShadow:
                "0 0 14px rgba(0,255,136,0.85), 0 0 32px rgba(0,255,136,0.45)",
            }}
            data-testid="text-countdown"
          >
            14:22:47
          </div>
          <div className="grid grid-cols-3 w-full max-w-[15rem] mt-1 font-mono text-[10px] uppercase tracking-widest text-white/80 text-center">
            <span>Hours</span>
            <span>Minutes</span>
            <span>Seconds</span>
          </div>
        </div>

        <div className="my-4 h-px w-full bg-primary/20" />

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col items-center text-center">
            <div className="font-mono text-[10px] uppercase tracking-widest text-white/80">
              Live Prize Pool
            </div>
            <div
              className="font-display font-bold text-xl tracking-wider whitespace-nowrap mt-0.5"
              style={{
                color: "#FFE14F",
                textShadow:
                  "0 0 10px rgba(255,225,79,0.85), 0 0 22px rgba(255,200,60,0.4)",
              }}
              data-testid="text-prize-pool"
            >
              4,820 USDT
            </div>
          </div>
          <div className="flex flex-col items-center text-center">
            <div className="font-mono text-[10px] uppercase tracking-widest text-white/80">
              Registered Players
            </div>
            <div
              className="font-display font-bold text-xl tracking-wider text-primary text-glow whitespace-nowrap mt-0.5"
              data-testid="text-registered-players"
            >
              482 Players
            </div>
          </div>
        </div>
      </motion.div>

      <div className="w-full grid grid-cols-2 gap-3">
        {DAYS.map((d, i) => (
          <motion.div
            key={d.day}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 + i * 0.06, duration: 0.4 }}
            className="flex flex-col items-center gap-1.5"
            data-testid={`card-day-${d.name.toLowerCase()}`}
          >
            <div className="font-mono text-xs uppercase tracking-widest text-white/90">
              {d.day}
            </div>

            <div
              className="relative aspect-square w-full rounded-2xl overflow-hidden border bg-black/60 backdrop-blur-sm transition-transform hover:scale-[1.02]"
              style={
                d.active
                  ? {
                      borderColor: "#FFE14F",
                      boxShadow:
                        "0 0 16px rgba(255,225,79,0.85), 0 0 34px rgba(255,200,60,0.45), inset 0 0 18px rgba(255,225,79,0.18)",
                    }
                  : {
                      borderColor: "rgba(0,255,136,0.35)",
                      boxShadow:
                        "0 0 10px rgba(0,255,136,0.18), inset 0 0 14px rgba(0,255,136,0.06)",
                    }
              }
            >
              <div
                className="absolute inset-0 bg-cover bg-center"
                style={{ backgroundImage: `url(${d.image})` }}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-black/40" />

              <div className="relative z-10 h-full w-full flex flex-col items-center justify-between p-2">
                <div
                  className="font-display font-bold text-base uppercase tracking-wider text-center whitespace-nowrap"
                  style={
                    d.active
                      ? {
                          color: "#FFE14F",
                          textShadow:
                            "0 0 8px rgba(255,225,79,0.9), 0 0 18px rgba(255,200,60,0.5)",
                        }
                      : {
                          color: "#fff",
                          textShadow:
                            "0 0 8px rgba(0,255,136,0.55), 0 0 16px rgba(0,255,136,0.25)",
                        }
                  }
                >
                  {d.name}
                </div>

                <div
                  className="font-mono text-xs uppercase tracking-wider px-2 py-0.5 rounded-md bg-black/70 border whitespace-nowrap"
                  style={
                    d.active
                      ? { borderColor: "rgba(255,225,79,0.55)", color: "#FFE14F" }
                      : { borderColor: "rgba(0,255,136,0.35)", color: "rgba(255,255,255,0.85)" }
                  }
                >
                  Entry 10 USDT
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </main>
  );
}
