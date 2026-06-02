import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import uz from "./locales/uz.json";
import uzCY from "./locales/uz-CY.json";
import ru from "./locales/ru.json";

export const LANGUAGES = [
  { code: "uz", label: "O'zbek (Lotin)" },
  { code: "uz-CY", label: "Ўзбек (Кирилл)" },
  { code: "ru", label: "Русский" },
] as const;

export type LangCode = (typeof LANGUAGES)[number]["code"];

const LANG_KEY = "azs_lang";

export function getSavedLang(): LangCode {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === "uz" || v === "uz-CY" || v === "ru") return v;
  } catch {
    /* ignore */
  }
  return "uz";
}

export function saveLang(code: LangCode) {
  try {
    localStorage.setItem(LANG_KEY, code);
  } catch {
    /* ignore */
  }
}

i18n.use(initReactI18next).init({
  resources: {
    uz: { translation: uz },
    "uz-CY": { translation: uzCY },
    ru: { translation: ru },
  },
  lng: getSavedLang(),
  fallbackLng: "uz",
  interpolation: { escapeValue: false },
});

export default i18n;
