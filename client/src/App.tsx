import { Switch, Route } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { GameProvider } from "@/context/GameContext";
import { LanguageProvider } from "@/context/LanguageContext";
import { Layout } from "@/components/layout/Layout";

import Landing from "@/pages/Landing";
import Rules from "@/pages/Rules";
import Games from "@/pages/Games";
import Lobby from "@/pages/Lobby";
import Play from "@/pages/Play";
import Preview from "@/pages/Preview";
import Result from "@/pages/Result";
import Wallet from "@/pages/Wallet";
import History from "@/pages/History";
import Challenge from "@/pages/Challenge";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/rules" component={Rules} />
        <Route path="/games" component={Games} />
        <Route path="/lobby" component={Lobby} />
        <Route path="/challenge/:challengeId" component={Challenge} />
        <Route path="/play/:gameId" component={Play} />
        <Route path="/preview/:gameId" component={Preview} />
        <Route path="/result" component={Result} />
        <Route path="/wallet" component={Wallet} />
        <Route path="/history" component={History} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <GameProvider>
          <Router />
          <Toaster />
        </GameProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
}

export default App;