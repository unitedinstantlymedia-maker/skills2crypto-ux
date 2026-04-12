import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { useLanguage } from "@/context/LanguageContext";
import { LanguageSelector } from "@/components/ui/LanguageSelector";
import logoImage from '@assets/2025-12-12_07.52.28_1765519599465.jpg';

export default function Landing() {
  const { t } = useLanguage();

  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] space-y-8 text-center relative">
      <div className="fixed top-4 left-4 z-50">
        <Link href="/rules">
          <div className="flex flex-col items-center cursor-pointer group pt-[2px]">
            <span className="text-2xl leading-none filter drop-shadow-md group-hover:scale-110 transition-transform">📜</span>
            <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground group-hover:text-primary transition-colors mt-1">
              {t('Rules', 'Rules')}
            </span>
          </div>
        </Link>
      </div>
      <div className="fixed top-4 right-4 z-50">
        <div className="transform scale-150 origin-top-right">
          <LanguageSelector />
        </div>
      </div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="space-y-2"
      >
        <div className="flex flex-col items-center justify-center gap-0">
          <h1 className="text-6xl font-display font-bold tracking-tighter text-transparent bg-clip-text bg-gradient-to-b from-white to-white/50 text-glow leading-none -mb-4 z-10">
            SKILLS
          </h1>
          <div className="relative z-0" style={{ width: '180px', height: '180px' }}>
            <img src={logoImage} alt="2" className="w-full h-full object-contain relative z-0" />
          </div>
          <h1 className="text-6xl font-display font-bold tracking-tighter text-transparent bg-clip-text bg-gradient-to-b from-white to-white/50 text-glow leading-none -mt-4 z-10">
            CRYPTO
          </h1>
        </div>
        <p className="text-2xl font-bold tracking-widest pt-6 text-transparent bg-clip-text bg-gradient-to-b from-[#E0E0E0] via-[#C0C0C0] to-[#808080] drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)] uppercase">
          {t('1v1 Crypto Wagers', '1v1 Crypto Wagers')}
        </p>
      </motion.div>

      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.5 }}
        className="flex flex-col gap-4 w-full max-w-xs"
      >
        <Link href="/games">
          <Button className="w-full h-14 text-lg font-display font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90 border-glow">
            {t('Play Now', 'Play Now')}
          </Button>
        </Link>

        <div className="flex justify-center items-center gap-6 mt-6">
          <div className="flex flex-col items-center gap-1" title="USDT">
            <div className="rounded-full" style={{ filter: 'drop-shadow(0 0 6px rgba(38,161,123,0.7)) drop-shadow(0 0 12px rgba(38,161,123,0.3))' }}>
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="20" cy="20" r="18" fill="#26A17B" />
                <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(38,161,123,0.4)" strokeWidth="1" />
                <path d="M16 13H24V15.5H21.5V27H18.5V15.5H16V13Z" fill="white" />
              </svg>
            </div>
            <span className="text-[10px] font-bold tracking-wider text-white/50">USDT</span>
          </div>

          <div className="flex flex-col items-center gap-1" title="ETH">
            <div className="rounded-full" style={{ filter: 'drop-shadow(0 0 6px rgba(140,140,200,0.6)) drop-shadow(0 0 12px rgba(140,140,200,0.25))' }}>
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="20" cy="20" r="18" fill="#3C3C3D" />
                <path d="M20 6L28 20L20 26L12 20L20 6Z" fill="#8A92B2" />
                <path d="M20 26L28 20L20 34L12 20L20 26Z" fill="#62688F" />
                <path d="M20 6L28 20L20 23L12 20L20 6Z" fill="none" stroke="rgba(138,146,178,0.3)" strokeWidth="0.5" />
              </svg>
            </div>
            <span className="text-[10px] font-bold tracking-wider text-white/50">ETH</span>
          </div>

          <div className="flex flex-col items-center gap-1" title="BNB">
            <div className="rounded-full" style={{ filter: 'drop-shadow(0 0 6px rgba(243,186,47,0.7)) drop-shadow(0 0 12px rgba(243,186,47,0.3))' }}>
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="20" cy="20" r="18" fill="#F3BA2F" />
                <path d="M20 10L23.5 13.5L18 19L15 16L20 10Z" fill="white" />
                <path d="M25 14L28 17L25 20L22 17L25 14Z" fill="white" />
                <path d="M20 19L23.5 22.5L18 28L15 25L20 19Z" fill="white" />
                <path d="M15 14L18 17L15 20L12 17L15 14Z" fill="white" />
                <path d="M20 16L22.5 18.5L20 21L17.5 18.5L20 16Z" fill="white" />
              </svg>
            </div>
            <span className="text-[10px] font-bold tracking-wider text-white/50">BNB</span>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
