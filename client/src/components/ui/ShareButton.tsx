import { Share2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ShareButtonProps {
  className?: string;
}

export function ShareButton({ className }: ShareButtonProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const shareData = {
      title: 'SKILLS2CRYPTO',
      text: 'Play 1v1 crypto skill games with me on SKILLS2CRYPTO! 🎮💸',
      url: window.location.origin
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(`${shareData.text} Try now: ${shareData.url}`);
        setCopied(true);
        toast({
          title: "Link Copied!",
          description: "Share link copied to clipboard.",
        });
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (err) {
      console.error('Error sharing:', err);
    }
  };

  return (
    <TooltipProvider>
      <Tooltip open={copied}>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            onClick={handleShare}
            className={cn(
              "rounded-full h-10 w-10 border-white/10 bg-white/5 hover:bg-white/10 hover:text-primary transition-all duration-300",
              "shadow-[0_4px_12px_rgba(0,0,0,0.3)] backdrop-blur-sm",
              className
            )}
          >
            {copied ? <Check className="h-5 w-5 text-green-500" /> : <Share2 className="h-5 w-5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{copied ? "Link copied!" : "Share App"}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
