import { useGame } from "@/context/GameContext";
import { useLanguage } from "@/context/LanguageContext";
import { Loader2 } from "lucide-react";

export function WaitingRoom() {
  const { state } = useGame();
  const { t } = useLanguage();

  const playerCount = state.currentMatch?.players.filter(p => p).length || 0;
  const isWaiting = playerCount < 2;

  return (
    <div className="h-full flex flex-col items-center justify-center space-y-8">
      {/* Status Header */}
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-display font-bold uppercase tracking-wider">
          {t('Waiting for Opponent', 'Waiting for Opponent')}
        </h1>
        <p className="text-muted-foreground font-mono">
          {t('Match ID', 'Match ID')}: {state.currentMatch?.id}
        </p>
      </div>

      {/* Match Details */}
      <div className="grid grid-cols-3 gap-6">
        <div className="text-center space-y-2">
          <div className="font-mono text-sm text-muted-foreground uppercase">
            {t('Game', 'Game')}
          </div>
          <div className="text-lg font-bold">{state.currentMatch?.game}</div>
        </div>
        <div className="text-center space-y-2">
          <div className="font-mono text-sm text-muted-foreground uppercase">
            {t('Stake', 'Stake')}
          </div>
          <div className="text-lg font-bold">
            {state.currentMatch?.stake} {state.selectedAsset}
          </div>
        </div>
        <div className="text-center space-y-2">
          <div className="font-mono text-sm text-muted-foreground uppercase">
            {t('Pot', 'Pot')}
          </div>
          <div className="text-lg font-bold">
            {(state.currentMatch?.stake || 0) * 2} {state.selectedAsset}
          </div>
        </div>
      </div>

      {/* Player Count */}
      <div className="text-center space-y-4">
        <div className="flex items-center justify-center gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
          <span className="font-mono text-sm uppercase">
            {t('Player', 'Player')} {playerCount}/2
          </span>
        </div>
        <div className="h-1 w-48 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${(playerCount / 2) * 100}%` }}
          />
        </div>
      </div>

      {/* Status Message */}
      {isWaiting && (
        <div className="text-center space-y-2 max-w-sm">
          <p className="text-muted-foreground">
            {t('An opponent is being matched. This usually takes a few seconds.', 'An opponent is being matched. This usually takes a few seconds.')}
          </p>
        </div>
      )}

      {/* Ready State */}
      {playerCount === 2 && (
        <div className="text-center space-y-2 animate-pulse">
          <div className="text-green-500 font-bold uppercase">
            {t('Both players ready!', 'Both players ready!')}
          </div>
          <p className="text-muted-foreground text-sm">
            {t('Game will start shortly...', 'Game will start shortly...')}
          </p>
        </div>
      )}
    </div>
  );
}
