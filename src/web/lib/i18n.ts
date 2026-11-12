// The app's languages: English and French, chosen by the user (kept in this browser) or else by the browser's own
// language. Components translate with `useTranslation("<area>")` and `t("key")`; dates and numbers format with
// `intlLocale()` and `dateLocale()`, so they follow the language too. `bun run i18n:lint` finds text left untranslated.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { enGB, fr as frDates } from "date-fns/locale";
import { LANGUAGES, resources, type Language } from "@/locales";

const STORAGE_KEY = "richelieu:language";

function detect(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGUAGES.some((l) => l.code === saved)) return saved as Language;
  } catch {}
  const browser = (navigator.languages?.[0] ?? navigator.language ?? "en").toLowerCase();
  return browser.startsWith("fr") ? "fr" : "en";
}

void i18n.use(initReactI18next).init({
  resources,
  lng: detect(),
  fallbackLng: "en",
  defaultNS: "common",
  ns: Object.keys(resources.en),
  interpolation: { escapeValue: false },
  returnNull: false,
});

const applyLang = (language: string) => {
  document.documentElement.lang = language;
};
applyLang(i18n.language);
i18n.on("languageChanged", applyLang);

export function setLanguage(language: Language) {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {}
  void i18n.changeLanguage(language);
}

export const currentLanguage = () => (i18n.resolvedLanguage ?? i18n.language ?? "en") as Language;

/** The Intl locale for dates and numbers in the current language: "en-GB" or "fr-FR". */
export const intlLocale = () => LANGUAGES.find((l) => l.code === currentLanguage())?.intl ?? "en-GB";

/** date-fns's locale for the current language. */
export const dateLocale = () => (currentLanguage() === "fr" ? frDates : enGB);

export default i18n;
