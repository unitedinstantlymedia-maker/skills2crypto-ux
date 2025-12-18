import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft, AlertTriangle, Wallet, Shield, Swords } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/context/LanguageContext";

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
        <h1 className="text-2xl font-display font-bold uppercase tracking-wider">{t('Rules & Risks', 'Rules & Risks')}</h1>
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
            {t('We support USDT, ETH, and TON. Ensure you have sufficient balance before playing. Wagers are locked in escrow during the match.', 'We support USDT, ETH, and TON. Ensure you have sufficient balance before playing. Wagers are locked in escrow during the match.')}
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

      </div>
    </div>
  );
}
