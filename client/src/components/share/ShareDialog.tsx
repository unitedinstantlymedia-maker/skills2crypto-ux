import { 
  Facebook, 
  Twitter, 
  Linkedin, 
  MessageCircle, 
  Send, 
  Copy,
  Mail
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareDialog({ open, onOpenChange }: ShareDialogProps) {
  const { toast } = useToast();
  const url = window.location.origin;
  const text = 'Play 1v1 crypto skill games with me on SKILLS2CRYPTO! 🎮💸';
  const fullText = `${text} Try now: ${url}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullText);
      toast({
        title: "Link Copied!",
        description: "Share link copied to clipboard.",
      });
      onOpenChange(false);
    } catch (err) {
      console.error('Error copying:', err);
    }
  };

  const shareLinks = [
    {
      name: 'WhatsApp',
      icon: MessageCircle,
      color: 'bg-[#25D366]',
      hoverColor: 'hover:bg-[#128C7E]',
      url: `https://wa.me/?text=${encodeURIComponent(fullText)}`
    },
    {
      name: 'Telegram',
      icon: Send,
      color: 'bg-[#0088cc]',
      hoverColor: 'hover:bg-[#0077b5]',
      url: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`
    },
    {
      name: 'Facebook',
      icon: Facebook,
      color: 'bg-[#1877F2]',
      hoverColor: 'hover:bg-[#166fe5]',
      url: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`
    },
    {
      name: 'X (Twitter)',
      icon: Twitter,
      color: 'bg-black',
      hoverColor: 'hover:bg-neutral-800',
      url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
    },
    {
      name: 'Reddit',
      icon: ({ className }: { className?: string }) => (
        <svg 
          viewBox="0 0 24 24" 
          fill="currentColor" 
          className={className}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/>
        </svg>
      ),
      color: 'bg-[#FF4500]',
      hoverColor: 'hover:bg-[#e03d00]',
      url: `https://reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(text)}`
    },
    {
      name: 'Discord',
      icon: ({ className }: { className?: string }) => (
        <svg 
          viewBox="0 0 24 24" 
          fill="currentColor" 
          className={className}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.419-2.1568 2.419zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.419-2.1568 2.419z"/>
        </svg>
      ),
      color: 'bg-[#5865F2]',
      hoverColor: 'hover:bg-[#4752c4]',
      url: `https://discord.com/channels/@me` // Note: Discord doesn't have a direct share URL, usually just link to server
    }
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-zinc-950 border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="text-xl font-display font-bold uppercase tracking-wider text-center">Share SKILLS2CRYPTO</DialogTitle>
          <DialogDescription className="text-center text-muted-foreground">
            Invite your friends to battle for crypto!
          </DialogDescription>
        </DialogHeader>
        
        <div className="grid grid-cols-3 gap-4 py-4">
          {shareLinks.map((link, index) => (
            <motion.a
              key={link.name}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col items-center gap-2 group cursor-pointer"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
            >
              <div className={cn(
                "w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-all duration-300",
                link.color,
                link.hoverColor
              )}>
                <link.icon className="w-8 h-8 text-white" />
              </div>
              <span className="text-xs font-medium text-muted-foreground group-hover:text-white transition-colors">
                {link.name}
              </span>
            </motion.a>
          ))}
        </div>

        <div className="relative mt-2">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-white/10" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-zinc-950 px-2 text-muted-foreground">Or copy link</span>
          </div>
        </div>

        <div className="flex items-center space-x-2 mt-2">
          <div className="grid flex-1 gap-2">
            <div className="h-10 px-3 rounded-md bg-white/5 border border-white/10 flex items-center text-sm text-muted-foreground truncate">
              {url}
            </div>
          </div>
          <Button type="button" size="icon" variant="secondary" onClick={handleCopy} className="h-10 w-10 shrink-0">
            <Copy className="h-4 w-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
