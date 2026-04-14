import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

export default function About() {
  const { t } = useLanguage();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/">
          <Button size="icon" variant="ghost" className="h-10 w-10 rounded-full">
            <ArrowLeft className="h-6 w-6" />
          </Button>
        </Link>
        <h1 className="text-2xl font-display font-bold uppercase tracking-wider">{t('About Us', 'About Us')}</h1>
      </div>

      <div className="space-y-6 px-2">
        <p className="text-xl font-display font-bold text-primary tracking-wide">
          {t('Your Skill. Your Currency.', 'Your Skill. Your Currency.')}
        </p>

        <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
          <p>
            {t("We're tired of banks blocking accounts. Tired of passports, selfies, and endless checks. Tired of casinos where only the house wins.", "We're tired of banks blocking accounts. Tired of passports, selfies, and endless checks. Tired of casinos where only the house wins.")}
          </p>

          <p className="text-base font-semibold text-foreground">
            Skill2Crypto {t('is a different breed.', 'is a different breed.')}
          </p>

          <div className="space-y-2 border-l-2 border-primary/40 pl-4">
            <p>{t('No sign-ups. Just your wallet.', 'No sign-ups. Just your wallet.')}</p>
            <p>{t('No luck. Just your skill.', 'No luck. Just your skill.')}</p>
            <p>{t('No middlemen. Just you versus an opponent.', 'No middlemen. Just you versus an opponent.')}</p>
          </div>

          <p>
            {t('You win? The money is instantly in your wallet. No delays, no "card verification", no frozen accounts.', 'You win? The money is instantly in your wallet. No delays, no "card verification", no frozen accounts.')}
          </p>

          <p className="text-base font-semibold text-accent">
            {t('Fair. Anonymous. Borderless.', 'Fair. Anonymous. Borderless.')}
          </p>

          <p>
            {t('Challenge friends or match with rivals worldwide. Play with USDT, ETH, BNB, or TON.', 'Challenge friends or match with rivals worldwide. Play with USDT, ETH, BNB, or TON.')}
          </p>

          <p className="text-base font-display italic text-primary/80 pt-2">
            {t('True freedom begins where control ends.', 'True freedom begins where control ends.')}
          </p>
        </div>
      </div>
    </div>
  );
}
