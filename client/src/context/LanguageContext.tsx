import React, { createContext, useContext, useState, useEffect } from 'react';
import { LANGUAGES, Language } from '@/data/languages';
import { TRANSLATIONS } from '../data/translations';

type LanguageContextType = {
  currentLanguage: Language;
  setLanguage: (code: string) => void;
  t: (key: string, defaultText?: string) => string;
};

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [languageCode, setLanguageCode] = useState('en');

  // Load from local storage on mount
  useEffect(() => {
    const stored = localStorage.getItem('skills2crypto_language');
    if (stored && LANGUAGES.find(l => l.code === stored)) {
      setLanguageCode(stored);
    }
  }, []);

  const setLanguage = (code: string) => {
    setLanguageCode(code);
    localStorage.setItem('skills2crypto_language', code);
  };

  const currentLanguage = LANGUAGES.find(l => l.code === languageCode) || LANGUAGES[0];

  const t = (key: string, defaultText?: string) => {
    if (languageCode === 'en') return defaultText || key;
    
    // Check if translation exists for current language
    const langTranslations = TRANSLATIONS[languageCode];
    if (langTranslations && langTranslations[key]) {
      return langTranslations[key];
    }
    
    return defaultText || key;
  };

  return (
    <LanguageContext.Provider value={{ currentLanguage, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}
