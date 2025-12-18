import { Link, useLocation } from "wouter";
import { Gamepad2, Wallet, History, Share2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { ShareDialog } from "@/components/share/ShareDialog";
import { useLanguage } from "@/context/LanguageContext";

export function BottomNav() {
  const [location] = useLocation();
  const { toast } = useToast();
  const [shareOpen, setShareOpen] = useState(false);
  const { t } = useLanguage();

  const isActive = (path: string) => {
    if (path === '/' && (location === '/' || location.startsWith('/games') || location.startsWith('/lobby') || location.startsWith('/play') || location.startsWith('/result'))) return true;
    return location === path;
  };

  const handleShare = async () => {
    // Try native share first
    const shareData = {
      title: 'SKILLS2CRYPTO',
      text: 'Play 1v1 crypto skill games with me on SKILLS2CRYPTO! 🎮💸',
      url: window.location.origin
    };

    if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
      try {
        await navigator.share(shareData);
      } catch (err) {
        // If user cancelled or failed, just fallback to dialog? 
        // Or ignore cancellation.
        console.log('Native share cancelled or failed', err);
      }
    } else {
      // On desktop or if native share not preferred, open custom dialog
      setShareOpen(true);
    }
  };

  const navItems = [
    { 
      path: '/', 
      label: t('Home', 'Home'), 
      icon: Gamepad2,
      color: 'bg-cyan-500/70',
      borderColor: 'border-blue-500/50',
      glowColor: 'shadow-blue-500/50',
      iconColor: 'text-blue-400'
    },
    { 
      path: '/wallet', 
      label: t('Wallet', 'Wallet'), 
      icon: Wallet,
      color: 'bg-emerald-500/70', // Matches Play Now primary/green style but semi-transparent
      borderColor: 'border-primary/50',
      glowColor: 'shadow-primary/50',
      iconColor: 'text-primary'
    },
    { 
      path: '/history', 
      label: t('History', 'History'), 
      icon: History,
      color: 'bg-purple-500/70', // Same semi-transparent style
      borderColor: 'border-purple-500/50',
      glowColor: 'shadow-purple-500/50',
      iconColor: 'text-purple-400'
    },
    { 
      path: '#share', 
      label: t('Share', 'Share'), 
      icon: Share2,
      color: 'bg-indigo-500/70', // Same semi-transparent style
      borderColor: 'border-blue-400/50',
      glowColor: 'shadow-blue-500/60',
      iconColor: 'text-blue-200',
      isAction: true
    }
  ];

  return (
    <div className="fixed bottom-4 sm:bottom-6 left-0 right-0 z-50 px-2 sm:px-6 flex justify-center pointer-events-none">
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} />
      <nav className="pointer-events-auto w-full sm:w-auto sm:min-w-[400px] flex items-center justify-between gap-2 p-1.5 sm:p-2 rounded-2xl sm:rounded-3xl bg-black/80 sm:bg-black/40 backdrop-blur-xl border border-white/10 sm:border-white/5 shadow-2xl relative">
        {navItems.map((item) => {
          const isShare = item.path === '#share';
          const active = isActive(item.path);
          
          const Content = () => (
            <motion.div
              className={cn(
                "relative w-full h-14 sm:h-16 rounded-xl sm:rounded-2xl flex flex-col items-center justify-center gap-0.5 sm:gap-1 transition-all duration-300",
                "border backdrop-blur-md shadow-lg cursor-pointer overflow-hidden px-1",
                 item.color, // Always apply solid semi-transparent color
                active 
                  ? cn("border-2", item.borderColor, item.glowColor, "shadow-[0_0_20px_rgba(0,0,0,0.5)]") 
                  : "border-white/10 hover:brightness-110" // No opacity changes, just brightness on hover
              )}
              animate={{ 
                y: active ? -8 : 0,
                scale: active ? 1.05 : 1,
              }}
              whileHover={{ 
                y: active ? -10 : -4,
                scale: 1.05 
              }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
            >
              {/* Glossy sheen */}
              <div className="absolute inset-0 bg-gradient-to-b from-white/10 to-transparent opacity-50 pointer-events-none" />

              {/* Icon */}
              <item.icon className={cn(
                "h-5 w-5 sm:h-6 sm:w-6 z-10 drop-shadow-md transition-colors duration-300",
                "text-white" // Always white/bright
              )} />
              
              {/* Label */}
              <span className={cn(
                "text-[9px] sm:text-[10px] font-bold uppercase tracking-widest z-10 transition-colors duration-300 truncate w-full text-center",
                "text-white" // Always white/bright
              )}>
                {item.label}
              </span>

              {/* Active Glow Background Effect */}
              {active && (
                <motion.div
                  layoutId="active-glow"
                  className={cn("absolute inset-0 opacity-30 bg-gradient-to-t", item.color)}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.3 }}
                />
              )}
            </motion.div>
          );

          if (isShare) {
            return (
              <div key={item.path} className="flex-1 min-w-0 relative group" onClick={handleShare}>
                 <Content />
              </div>
            );
          }

          return (
            <div key={item.path} className="flex-1 min-w-0 relative group">
              <Link href={item.path} className="block w-full">
                <Content />
                
                {/* Reflection/Shadow underneath when lifted */}
                {active && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className={cn(
                      "absolute -bottom-4 left-1/2 -translate-x-1/2 w-12 sm:w-16 h-2 rounded-full blur-md opacity-50",
                      item.iconColor.replace('text-', 'bg-')
                    )}
                  />
                )}
              </Link>
            </div>
          );
        })}
      </nav>
    </div>
  );
}
