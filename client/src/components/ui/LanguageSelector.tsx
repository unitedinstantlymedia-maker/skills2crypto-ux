import React, { useState } from "react";
import { Check, Globe, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useLanguage } from "@/context/LanguageContext";
import { LANGUAGES } from "@/data/languages";

export function LanguageSelector() {
  const [open, setOpen] = useState(false);
  const { currentLanguage, setLanguage, t } = useLanguage();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <div className="flex flex-col items-center cursor-pointer group">
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-10 w-10 rounded-full bg-white/5 hover:bg-white/10 hover:text-white border border-white/10"
          >
            <span className="text-2xl leading-none filter drop-shadow-md group-hover:scale-110 transition-transform">{currentLanguage.flag}</span>
          </Button>
          <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground group-hover:text-primary transition-colors mt-1">
            {t('Select Language', 'Select Language')}
          </span>
        </div>
      </DialogTrigger>
      <DialogContent className="p-0 gap-0 bg-background/95 backdrop-blur-xl border-white/10 sm:max-w-[425px]">
        <DialogHeader className="px-4 py-3 border-b border-white/10">
          <DialogTitle className="text-lg font-display tracking-wide">{t('Select Language', 'Select Language')}</DialogTitle>
        </DialogHeader>
        <Command className="bg-transparent">
          <CommandInput placeholder={t('Search language...', 'Search language...')} />
          <CommandList className="max-h-[60vh] overflow-y-auto custom-scrollbar">
            <CommandEmpty>{t('No language found.', 'No language found.')}</CommandEmpty>
            <CommandGroup>
              {LANGUAGES.map((language) => (
                <CommandItem
                  key={language.code}
                  value={`${language.name} ${language.nativeName}`}
                  onSelect={() => {
                    setLanguage(language.code);
                    setOpen(false);
                  }}
                  className="flex items-center gap-3 py-3 px-4 cursor-pointer aria-selected:bg-white/5"
                >
                  <span className="text-2xl">{language.flag}</span>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">
                      {language.nativeName}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {language.name}
                    </span>
                  </div>
                  <Check
                    className={cn(
                      "ml-auto h-4 w-4 text-primary",
                      currentLanguage.code === language.code ? "opacity-100" : "opacity-0"
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
