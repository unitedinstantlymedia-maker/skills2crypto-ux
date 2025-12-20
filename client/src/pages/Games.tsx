import { useGame } from "@/context/useGame";
import { GameType } from "@/lib/types";
import { Link, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import battleshipImage from '@assets/stock_images/battleship_navy_ship_31f24312.jpg';
import stockImage from '@assets/stock_images/classic_tetris_game__1bffc655.jpg'; // Keeping this as backup or unused if I replace it
import photorealisticChessImage from '@assets/generated_images/elegant_photorealistic_chess_pieces.png';
import cleanTetrisImage from '@assets/generated_images/clean_3d_colorful_tetris_blocks.png';
import photorealisticCheckersImage from '@assets/generated_images/classic_photorealistic_checkers_board.png';
import cinematicBattleshipImage from '@assets/generated_images/cinematic_realistic_battleship_game.png';
import { useLanguage } from "@/context/LanguageContext";

const GAMES: { id: GameType; name: string; image: string; players: string }[] = [
  { 
    id: 'Chess', 
    name: 'Chess', 
    image: photorealisticChessImage,
    players: '1.2k'
  },
  { 
    id: 'Tetris', 
    name: 'TETRIS', 
    image: cleanTetrisImage,
    players: '850'
  },
  { 
    id: 'Checkers', 
    name: 'Checkers Pro', 
    image: photorealisticCheckersImage,
    players: '430'
  },
  { 
    id: 'Battleship', 
    name: 'Battleship', 
    image: cinematicBattleshipImage,
    players: '342'
  }
];

export default function Games() {
  const { actions } = useGame();
  const [, setLocation] = useLocation();
  const { t } = useLanguage();

  const handleSelectGame = (gameId: GameType) => {
    actions.selectGame(gameId as any); // Cast for safety if types slightly mismatch
    setLocation('/lobby');
  };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-display font-bold uppercase tracking-wider text-glow">{t('Select Game', 'Select Game')}</h1>
      
      <div className="grid gap-4">
        {GAMES.map((game, index) => (
          <motion.div
            key={game.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.1 }}
          >
            <Card 
              className="group relative overflow-hidden cursor-pointer border-white/10 hover:border-white/20 transition-all duration-500 backdrop-blur-sm bg-black/40"
              onClick={() => handleSelectGame(game.id)}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/40 to-transparent z-10" />
              <div className="absolute inset-0 bg-black/20 z-[5] backdrop-blur-[1px]" />
              <div 
                className="absolute inset-0 bg-cover bg-center group-hover:scale-105 transition-transform duration-700 ease-out"
                style={{ backgroundImage: `url(${game.image})` }}
              />
              
              <CardContent className="relative z-20 p-6 h-32 flex flex-col justify-center">
                <h2 className="text-2xl font-display font-bold uppercase tracking-wider text-white group-hover:text-white/90 transition-colors drop-shadow-md">
                  {t(game.name, game.name)}
                </h2>
                <p className="text-sm text-muted-foreground font-mono mt-1 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  {game.players} {t('playing', 'playing')}
                </p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
