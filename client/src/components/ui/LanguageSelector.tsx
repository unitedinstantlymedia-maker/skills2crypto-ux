
import * as React from "react";
import { Check, Globe, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useLanguage } from "@/context/LanguageContext";
import { LANGUAGES } from "@/data/languages";

export function LanguageSelector() {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const { currentLanguage, setLanguage } = useLanguage();

  const filteredLanguages = React.useMemo(() => {
    if (!search) return LANGUAGES;
    return LANGUAGES.filter(
      (lang) =>
        lang.name.toLowerCase().includes(search.toLowerCase()) ||
        lang.nativeName.toLowerCase().includes(search.toLowerCase()) ||
        lang.code.toLowerCase().includes(search.toLowerCase())
    );
  }, [search]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-[200px] justify-between bg-card/50 border-white/10"
        >
          <Globe className="mr-2 h-4 w-4" />
          {currentLanguage.nativeName}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0">
        <Command>
          <CommandInput
            placeholder="Search language..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandEmpty>No language found.</CommandEmpty>
          <CommandList>
            <CommandGroup>
              {filteredLanguages.map((language) => (
                <CommandItem
                  key={language.code}
                  value={language.code}
                  onSelect={() => {
                    setLanguage(language.code);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      currentLanguage.code === language.code
                        ? "opacity-100"
                        : "opacity-0"
                    )}
                  />
                  <div className="flex flex-col">
                    <span className="font-medium">{language.nativeName}</span>
                    <span className="text-xs text-muted-foreground">
                      {language.name}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
