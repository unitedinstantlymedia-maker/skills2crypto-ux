import { useEffect } from "react";
import { Switch, Route } from "wouter";
import { Toaster } from "@/components/ui/toaster";
import { GameProvider } from "@/context/GameContext";
import { LanguageProvider } from "@/context/LanguageContext";
import { WalletProvider } from "@/core/wallet/WalletProvider";
import { Layout } from "@/components/layout/Layout";
import { ensureFeeSnapshotLoaded } from "@/core/networkFees";

import Landing from "@/pages/Landing";
import Rules from "@/pages/Rules";
import About from "@/pages/About";
import Games from "@/pages/Games";
import Lobby from "@/pages/Lobby";
import Play from "@/pages/Play";
import Result from "@/pages/Result";
import Wallet from "@/pages/Wallet";
import History from "@/pages/History";
import Tournaments from "@/pages/Tournaments";
import Challenge from "@/pages/Challenge";
import Refund from "@/pages/Refund";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/rules" component={Rules} />
        <Route path="/about" component={About} />
        <Route path="/games" component={Games} />
        <Route path="/lobby" component={Lobby} />
        <Route path="/challenge/:challengeId" component={Challenge} />
        <Route path="/play/:gameId" component={Play} />
        <Route path="/result" component={Result} />
        <Route path="/wallet" component={Wallet} />
        <Route path="/history" component={History} />
        <Route path="/tournaments" component={Tournaments} />
        <Route path="/refund" component={Refund} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  // Prime the live network-fee cache at boot so the wager UI shows
  // real numbers on the first paint of /lobby. Errors are swallowed —
  // adapters fall back to legacy hard-coded values.
  useEffect(() => {
    void ensureFeeSnapshotLoaded();
  }, []);
  return (
    <LanguageProvider>
      <WalletProvider>
        <GameProvider>
          <Router />
          <Toaster />
        </GameProvider>
      </WalletProvider>
    </LanguageProvider>
  );
}

export default App;
