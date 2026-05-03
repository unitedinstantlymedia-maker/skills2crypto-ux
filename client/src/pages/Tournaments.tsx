import { motion } from "framer-motion";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";

export default function Tournaments() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12 bg-background text-foreground">
      <Link href="/">
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-4 left-4 text-white/70 hover:text-white"
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
        className="font-display font-bold text-3xl md:text-5xl uppercase tracking-widest text-center"
        style={{
          color: "#FFC53D",
          textShadow:
            "0 0 12px rgba(255,197,61,0.65), 0 0 28px rgba(255,170,40,0.35)",
        }}
        data-testid="text-tournaments-title"
      >
        Tournaments Coming Soon
      </motion.h1>
    </div>
  );
}
