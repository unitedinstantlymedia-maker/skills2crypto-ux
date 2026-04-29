import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Wallet, Shield, Swords, Crown, Gamepad2, Grid3X3, Ship, Square, Castle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/context/LanguageContext";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function Rules() {
  const { t } = useLanguage();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/">
          <Button size="icon" variant="ghost" className="h-10 w-10 rounded-full">
            <ArrowLeft className="h-6 w-6" />
          </Button>
        </Link>
        <h1 className="text-2xl font-display font-bold uppercase tracking-wider">{t('Rules', 'Rules')}</h1>
      </div>

      <div className="space-y-4">
        <Card className="bg-card/50 border-white/10 backdrop-blur-sm">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2 text-primary">
              <Swords className="h-5 w-5" />
              <CardTitle className="font-display uppercase tracking-wide text-lg">{t('Fair Play', 'Fair Play')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed">
            {t('Matches are 1v1 skill-based. No chance involved. The winner takes the pot minus fees.', 'Matches are 1v1 skill-based. No chance involved. The winner takes the pot minus fees.')}
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-white/10 backdrop-blur-sm">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2 text-accent">
              <Wallet className="h-5 w-5" />
              <CardTitle className="font-display uppercase tracking-wide text-lg">{t('Crypto Only', 'Crypto Only')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed">
            {t('We support USDT, ETH, BNB, and TON. Ensure you have sufficient balance before playing. Wagers are locked in escrow during the match.', 'We support USDT, ETH, BNB, and TON. Ensure you have sufficient balance before playing. Wagers are locked in escrow during the match.')}
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-white/10 backdrop-blur-sm">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2 text-yellow-500">
              <Shield className="h-5 w-5" />
              <CardTitle className="font-display uppercase tracking-wide text-lg">{t('Platform Fee', 'Platform Fee')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed">
            {t('A flat 3% fee is deducted from the total pot of every match to support platform development and maintenance.', 'A flat 3% fee is deducted from the total pot of every match to support platform development and maintenance.')}
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-white/10 backdrop-blur-sm">
          <CardHeader className="pb-2">
            <CardTitle className="font-display uppercase tracking-wide text-lg">{t('Game Rules', 'Game Rules')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="chess" className="w-full">
              <TabsList className="grid w-full grid-cols-6 mb-4">
                <TabsTrigger value="chess" className="text-xs"><Crown className="h-3 w-3 mr-1" />{t('Chess', 'Chess')}</TabsTrigger>
                <TabsTrigger value="tetris" className="text-xs"><Gamepad2 className="h-3 w-3 mr-1" />{t('Tetris', 'Tetris')}</TabsTrigger>
                <TabsTrigger value="checkers" className="text-xs"><Grid3X3 className="h-3 w-3 mr-1" />{t('Checkers', 'Checkers')}</TabsTrigger>
                <TabsTrigger value="battleship" className="text-xs"><Ship className="h-3 w-3 mr-1" />{t('Battleship', 'Battleship')}</TabsTrigger>
                <TabsTrigger value="dominoes" className="text-xs"><Square className="h-3 w-3 mr-1" />{t('Dominoes', 'Dominoes')}</TabsTrigger>
                <TabsTrigger value="xiangqi" className="text-xs"><Castle className="h-3 w-3 mr-1" />{t('Xiangqi', 'Xiangqi')}</TabsTrigger>
              </TabsList>
              <TabsContent value="chess" className="text-sm text-muted-foreground space-y-2">
                <p>{t('Standard chess rules apply. Each player has 30 minutes on their clock.', 'Standard chess rules apply. Each player has 30 minutes on their clock.')}</p>
                <p>{t('Win by checkmate, opponent resignation, or timeout. Draws are possible via stalemate.', 'Win by checkmate, opponent resignation, or timeout. Draws are possible via stalemate.')}</p>
                <p>{t('Tap or drag pieces to move. Legal moves are highlighted.', 'Tap or drag pieces to move. Legal moves are highlighted.')}</p>
              </TabsContent>
              <TabsContent value="tetris" className="text-sm text-muted-foreground space-y-2">
                <p>{t('Classic block-stacking rules. Clear lines to score points.', 'Classic block-stacking rules. Clear lines to score points.')}</p>
                <p>{t('Speed increases with level. Game ends when blocks reach the top.', 'Speed increases with level. Game ends when blocks reach the top.')}</p>
                <p>{t('Controls: Arrow keys to move, Space/Up to rotate, Shift for hard drop.', 'Controls: Arrow keys to move, Space/Up to rotate, Shift for hard drop.')}</p>
                <p>{t('First player to lose wins for opponent. See opponent\'s board in real-time.', 'First player to lose wins for opponent. See opponent\'s board in real-time.')}</p>
              </TabsContent>
              <TabsContent value="checkers" className="text-sm text-muted-foreground space-y-2">
                <p>{t('Standard checkers rules. Each player has 10 minutes.', 'Standard checkers rules. Each player has 10 minutes.')}</p>
                <p>{t('Mandatory captures - you must jump if able. Multi-jumps required when available.', 'Mandatory captures - you must jump if able. Multi-jumps required when available.')}</p>
                <p>{t('Reach opponent\'s back row to crown a King, which can move backward.', 'Reach opponent\'s back row to crown a King, which can move backward.')}</p>
                <p>{t('Win by capturing all pieces or blocking all opponent moves.', 'Win by capturing all pieces or blocking all opponent moves.')}</p>
              </TabsContent>
              <TabsContent value="battleship" className="text-sm text-muted-foreground space-y-2">
                <p>{t('Place 5 ships on your grid: Carrier (5), Battleship (4), Cruiser (3), Submarine (3), Destroyer (2).', 'Place 5 ships on your grid: Carrier (5), Battleship (4), Cruiser (3), Submarine (3), Destroyer (2).')}</p>
                <p>{t('Take turns firing at enemy coordinates. Hit = red, Miss = gray.', 'Take turns firing at enemy coordinates. Hit = red, Miss = gray.')}</p>
                <p>{t('60 seconds per turn. First to sink all 5 enemy ships wins.', '60 seconds per turn. First to sink all 5 enemy ships wins.')}</p>
              </TabsContent>
              <TabsContent value="dominoes" className="text-sm text-muted-foreground space-y-2">
                <p>{t('Double-six block dominoes. Each player is dealt 7 tiles; 14 tiles stay face-down (no draws).', 'Double-six block dominoes. Each player is dealt 7 tiles; 14 tiles stay face-down (no draws).')}</p>
                <p>{t('The player holding the highest double leads with that tile. Each turn, place a tile whose pip matches an open end of the chain.', 'The player holding the highest double leads with that tile. Each turn, place a tile whose pip matches an open end of the chain.')}</p>
                <p>{t('If you have no legal move, you must pass. Two consecutive passes = blocked board: lowest pip count wins, ties draw.', 'If you have no legal move, you must pass. Two consecutive passes = blocked board: lowest pip count wins, ties draw.')}</p>
                <p>{t('First player to empty their hand wins. 10 minutes per side on the clock.', 'First player to empty their hand wins. 10 minutes per side on the clock.')}</p>
              </TabsContent>
              <TabsContent value="xiangqi" className="text-sm text-muted-foreground space-y-2">
                <p>{t('Chinese Chess on a 9×10 board. Pieces sit on intersections. Red moves first. Each player has 15 minutes on the clock.', 'Chinese Chess on a 9×10 board. Pieces sit on intersections. Red moves first. Each player has 15 minutes on the clock.')}</p>
                <p>{t('Pieces: General 帥/將, Advisor 仕/士, Elephant 相/象, Horse 傌/馬, Chariot 俥/車, Cannon 炮/砲, Soldier 兵/卒.', 'Pieces: General 帥/將, Advisor 仕/士, Elephant 相/象, Horse 傌/馬, Chariot 俥/車, Cannon 炮/砲, Soldier 兵/卒.')}</p>
                <p>{t('General and Advisor stay inside the 3×3 palace. Elephant cannot cross the river. Horse can be hobbled. Cannon needs exactly one screen to capture. Soldier gains sideways movement after crossing the river.', 'General and Advisor stay inside the 3×3 palace. Elephant cannot cross the river. Horse can be hobbled. Cannon needs exactly one screen to capture. Soldier gains sideways movement after crossing the river.')}</p>
                <p>{t('Win by checkmate, stalemate (mover loses), capturing the General, or opponent timeout. Mutual draw offer is supported.', 'Win by checkmate, stalemate (mover loses), capturing the General, or opponent timeout. Mutual draw offer is supported.')}</p>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
