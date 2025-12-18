import { useGame } from "@/context/GameContext";
import { Card, CardContent } from "@/components/ui/card";
import { format } from "date-fns";
import { Trophy, XCircle, Handshake } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

export default function History() {
  const { state } = useGame();
  const { history } = state;
  const { t } = useLanguage();

  return (
    <div className="space-y-6">
      <div className="flex justify-center items-center">
        <h1 className="text-2xl font-display font-bold uppercase tracking-wider">{t('Match History', 'Match History')}</h1>
      </div>

      {history.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>{t('No matches played yet', 'No matches played yet.')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {history.map((item) => {
            const isWin = item.result === 'win';
            const isDraw = item.result === 'draw';
            
            return (
              <Card key={item.id} className="bg-card/50 border-white/10">
                <CardContent className="p-4 flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                      isWin ? 'bg-primary/20 text-primary' : 
                      isDraw ? 'bg-yellow-500/20 text-yellow-400' : 
                      'bg-destructive/20 text-destructive'
                    }`}>
                      {isWin ? <Trophy className="h-5 w-5" /> : isDraw ? <Handshake className="h-5 w-5" /> : <XCircle className="h-5 w-5" />}
                    </div>
                    <div>
                      <p className="font-display font-bold uppercase">{t(item.game, item.game)}</p>
                      <p className="text-xs text-muted-foreground font-mono">
                        {format(item.timestamp, 'MMM d, HH:mm')}
                      </p>
                    </div>
                  </div>
                  
                  <div className="text-right">
                    <p className={`font-mono font-bold ${
                      isWin ? 'text-primary' : 
                      isDraw ? 'text-yellow-400' : 
                      'text-destructive'
                    }`}>
                      {isWin ? '+' : isDraw ? '↩' : '-'}{
                        isWin ? Number(item.payout).toFixed(4) : 
                        isDraw ? Number(item.payout).toFixed(4) : 
                        Number(item.stake).toFixed(4)
                      } {item.asset}
                    </p>
                    <p className="text-xs text-muted-foreground font-mono">
                      {isWin ? t('Payout', 'Payout') : isDraw ? t('Draw', 'Draw') : t('Lost', 'Lost')}
                    </p>
                    <div className="text-[10px] text-muted-foreground font-mono mt-1">
                       {t('Initial Stake', 'Stake')}: {Number(item.stake).toFixed(2)} | {t('Fee', 'Fee')}: {Number(item.fee).toFixed(2)} | {t('Profit', 'Profit')}: {
                         isWin ? '+' + (Number(item.payout) - Number(item.stake)).toFixed(2) : 
                         isDraw ? '0.00' :
                         `-${Number(item.stake).toFixed(2)}`
                       }
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
