import { useGame } from "@/context/GameContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, Wallet as WalletIcon, ShieldCheck, LogOut, UserCircle, Pencil, ExternalLink, Globe, Loader2 } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { useRealWallet, REQUIRED_CHAIN } from "@/core/wallet/WalletProvider";
import { useState } from "react";
import { NicknameDialog } from "@/components/wallet/NicknameDialog";
import type { Asset } from "@/core/types";

export default function Wallet() {
  const { state } = useGame();
  const { wallet } = state;
  const { t } = useLanguage();
  const {
    openConnectDialog,
    disconnectAll,
    evmAddress,
    isEvmConnected,
    nickname,
    setNickname,
    currentChainName,
    switchToChain,
    isCorrectChainForAsset,
    isSwitchingChain,
    isTronLinkInstalled,
    isTronConnected,
    tronAddress,
    usdtTrc20Balance,
    isTronConnecting,
    connectTronLink,
    disconnectTronLink,
    usdtBscBalance,
  } = useRealWallet();
  const [nicknameDialogOpen, setNicknameDialogOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = (addr: string, label: string) => {
    navigator.clipboard.writeText(addr);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const isAnyConnected = isEvmConnected || isTronConnected;

  if (!wallet.connected && !isAnyConnected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6 text-center">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-primary/20 blur-xl animate-pulse" />
          <div className="relative h-20 w-20 rounded-full bg-card border border-white/10 flex items-center justify-center">
            <WalletIcon className="h-10 w-10 text-primary" />
          </div>
        </div>

        <div className="space-y-2">
          <h1 className="text-3xl font-display font-bold uppercase tracking-wider">{t('Connect Wallet')}</h1>
          <p className="text-muted-foreground max-w-xs mx-auto">
            {t('Connect your non-custodial wallet to play. No registration required.')}
          </p>
        </div>

        <div className="w-full max-w-xs space-y-3">
          <Button
            onClick={openConnectDialog}
            className="h-14 px-8 text-lg font-display font-bold uppercase tracking-widest bg-primary text-primary-foreground hover:bg-primary/90 border-glow w-full"
          >
            {t('Connect Now')}
          </Button>

          {isTronLinkInstalled && (
            <Button
              onClick={connectTronLink}
              disabled={isTronConnecting}
              variant="outline"
              className="h-14 px-8 text-base font-display font-bold uppercase tracking-widest border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300 w-full"
            >
              {isTronConnecting ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{t('Connecting...')}</>
              ) : (
                <><TronIcon className="h-5 w-5 mr-2" />{t('Connect TronLink')}</>
              )}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const shortenAddr = (addr: string) =>
    addr.length > 14 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-display font-bold uppercase tracking-wider">{t('My Wallet')}</h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={disconnectAll}
          className="text-muted-foreground hover:text-red-400"
        >
          <LogOut className="h-4 w-4 mr-1" />
          {t('Disconnect')}
        </Button>
      </div>

      {nickname && (
        <div className="flex items-center gap-2">
          <UserCircle className="h-5 w-5 text-primary" />
          <span className="font-display font-bold text-lg">{nickname}</span>
          <button onClick={() => setNicknameDialogOpen(true)} className="text-muted-foreground hover:text-white">
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {!nickname && (
        <Button variant="outline" size="sm" onClick={() => setNicknameDialogOpen(true)} className="border-white/10">
          <UserCircle className="h-4 w-4 mr-2" />
          {t('Choose Nickname')}
        </Button>
      )}

      <div className="space-y-3">
        {isEvmConnected && evmAddress && (
          <Card className="bg-gradient-to-br from-blue-500/10 to-card border-blue-500/20">
            <CardHeader className="pb-2">
              <div className="flex justify-between items-start">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-blue-400" />
                    <CardTitle className="text-xs text-blue-400 font-bold uppercase tracking-wider">EVM (ETH / BNB / USDT)</CardTitle>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-sm text-white">
                    {shortenAddr(evmAddress)}
                    <Copy
                      className="h-3.5 w-3.5 text-muted-foreground cursor-pointer hover:text-white"
                      onClick={() => handleCopy(evmAddress, 'evm')}
                    />
                    {copied === 'evm' && <span className="text-xs text-green-400">{t('Copied')}</span>}
                  </div>
                  {currentChainName && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <Globe className="h-3 w-3 text-muted-foreground" />
                      <span className="text-[10px] text-muted-foreground">{t('Network')}: <span className="text-white">{currentChainName}</span></span>
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={openConnectDialog}
                  className="text-xs text-muted-foreground hover:text-white"
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  {t('Manage')}
                </Button>
              </div>
            </CardHeader>
          </Card>
        )}

        {isTronConnected && tronAddress && (
          <Card className="bg-gradient-to-br from-red-500/10 to-card border-red-500/20">
            <CardHeader className="pb-2">
              <div className="flex justify-between items-start">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <TronIcon className="h-4 w-4 text-red-400" />
                    <CardTitle className="text-xs text-red-400 font-bold uppercase tracking-wider">TRON (USDT TRC-20)</CardTitle>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-sm text-white">
                    {shortenAddr(tronAddress)}
                    <Copy
                      className="h-3.5 w-3.5 text-muted-foreground cursor-pointer hover:text-white"
                      onClick={() => handleCopy(tronAddress, 'tron')}
                    />
                    {copied === 'tron' && <span className="text-xs text-green-400">{t('Copied')}</span>}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <Globe className="h-3 w-3 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground">{t('Network')}: <span className="text-white">Tron</span></span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={disconnectTronLink}
                  className="text-xs text-muted-foreground hover:text-red-400"
                >
                  <LogOut className="h-3 w-3 mr-1" />
                  {t('Disconnect')}
                </Button>
              </div>
            </CardHeader>
          </Card>
        )}

        {!isEvmConnected && (
          <Button variant="outline" size="sm" onClick={openConnectDialog} className="border-white/10 text-sm w-full">
            <ShieldCheck className="h-4 w-4 mr-2 text-blue-400" />
            {t('Connect')} EVM
          </Button>
        )}

        {!isTronConnected && isTronLinkInstalled && (
          <Button
            variant="outline"
            size="sm"
            onClick={connectTronLink}
            disabled={isTronConnecting}
            className="border-red-500/20 text-sm w-full text-red-400 hover:bg-red-500/10"
          >
            {isTronConnecting ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{t('Connecting...')}</>
            ) : (
              <><TronIcon className="h-4 w-4 mr-2" />{t('Connect TronLink')}</>
            )}
          </Button>
        )}
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t('Your Balances')}</h2>
        </div>

        <Card className="bg-card/50 border-white/10">
          <CardContent className="p-4 space-y-3">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-3">
                <svg width="32" height="32" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="20" cy="20" r="18" fill="#26A17B" />
                  <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(38,161,123,0.4)" strokeWidth="1" />
                  <path d="M16 13H24V15.5H21.5V27H18.5V15.5H16V13Z" fill="white" />
                </svg>
                <div>
                  <span className="font-display font-bold">USDT</span>
                  <div className="text-[10px] text-green-400">{t('Multi-Network')}</div>
                </div>
              </div>
              <div className="font-mono font-bold text-lg">
                {(wallet.balances.USDT ?? 0).toFixed(4)}
              </div>
            </div>

            <div className="space-y-1.5 pl-11">
              {isEvmConnected && (
                <div className="flex justify-between text-xs">
                  <span className="text-yellow-400/70">BNB Smart Chain (BEP-20)</span>
                  <span className="font-mono text-muted-foreground">{usdtBscBalance.toFixed(4)}</span>
                </div>
              )}
              {isTronConnected && (
                <div className="flex justify-between text-xs">
                  <span className="text-red-400/70">Tron (TRC-20)</span>
                  <span className="font-mono text-muted-foreground">{usdtTrc20Balance.toFixed(4)}</span>
                </div>
              )}
            </div>

            {isEvmConnected && !isCorrectChainForAsset('USDT') && !isTronConnected && (
              <div className="flex items-center justify-between gap-2 p-2 rounded-md bg-amber-500/10 border border-amber-500/20">
                <span className="text-[11px] text-amber-400">
                  {t('Switch to')} {REQUIRED_CHAIN.USDT.name} {t('to play with')} USDT
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isSwitchingChain}
                  onClick={() => switchToChain(REQUIRED_CHAIN.USDT.chainId)}
                  className="h-7 text-[10px] px-3 border-amber-500/30 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300 whitespace-nowrap"
                >
                  {isSwitchingChain ? t('Switching...') : `${t('Switch to')} ${REQUIRED_CHAIN.USDT.name}`}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {(['ETH', 'BNB'] as const).map((asset) => {
          const required = REQUIRED_CHAIN[asset];
          const onCorrectChain = isCorrectChainForAsset(asset);
          return (
            <Card key={asset} className="bg-card/50 border-white/10">
              <CardContent className="p-4 space-y-2">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    {asset === 'ETH' && (
                      <svg width="32" height="32" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="20" cy="20" r="18" fill="#3C3C3D" />
                        <path d="M20 6L28 20L20 26L12 20L20 6Z" fill="#8A92B2" />
                        <path d="M20 26L28 20L20 34L12 20L20 26Z" fill="#62688F" />
                        <path d="M20 6L28 20L20 23L12 20L20 6Z" fill="none" stroke="rgba(138,146,178,0.3)" strokeWidth="0.5" />
                      </svg>
                    )}
                    {asset === 'BNB' && (
                      <svg width="32" height="32" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="20" cy="20" r="18" fill="#F3BA2F" />
                        <path d="M20 10L23.5 13.5L18 19L15 16L20 10Z" fill="white" />
                        <path d="M25 14L28 17L25 20L22 17L25 14Z" fill="white" />
                        <path d="M20 19L23.5 22.5L18 28L15 25L20 19Z" fill="white" />
                        <path d="M15 14L18 17L15 20L12 17L15 14Z" fill="white" />
                        <path d="M20 16L22.5 18.5L20 21L17.5 18.5L20 16Z" fill="white" />
                      </svg>
                    )}
                    <div>
                      <span className="font-display font-bold">{asset}</span>
                      <div className={`text-[10px] ${asset === 'ETH' ? 'text-blue-400' : 'text-yellow-400'}`}>
                        {asset === 'ETH' ? 'Ethereum' : 'BNB Smart Chain'}
                      </div>
                    </div>
                  </div>
                  <div className="font-mono font-bold text-lg">
                    {(wallet.balances[asset] ?? 0).toFixed(4)}
                  </div>
                </div>

                {isEvmConnected && !onCorrectChain && (
                  <div className="flex items-center justify-between gap-2 p-2 rounded-md bg-amber-500/10 border border-amber-500/20">
                    <span className="text-[11px] text-amber-400">
                      {t('Switch to')} {required.name} {t('to play with')} {asset}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isSwitchingChain}
                      onClick={() => switchToChain(required.chainId)}
                      className="h-7 text-[10px] px-3 border-amber-500/30 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300 whitespace-nowrap"
                    >
                      {isSwitchingChain ? t('Switching...') : `${t('Switch to')} ${required.name}`}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <NicknameDialog
        open={nicknameDialogOpen}
        onOpenChange={setNicknameDialogOpen}
        onSave={setNickname}
      />
    </div>
  );
}

function TronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2L3 9L10 22L21 7L12 2Z" fill="currentColor" opacity="0.8" />
      <path d="M12 2L3 9L10 22L12 2Z" fill="currentColor" opacity="0.6" />
      <path d="M12 2L21 7L10 22L12 2Z" fill="currentColor" />
    </svg>
  );
}
