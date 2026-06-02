import { useTranslation } from "react-i18next";
import { LANGUAGES, saveLang, type LangCode } from "../i18n";

const SHORT: Record<LangCode, string> = { "uz": "UZ", "uz-CY": "УЗ", "ru": "RU" };

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = i18n.language as LangCode;

  return (
    <select
      value={current}
      onChange={(e) => {
        const code = e.target.value as LangCode;
        saveLang(code);
        void i18n.changeLanguage(code);
      }}
      aria-label="Language"
      className="cursor-pointer appearance-none rounded-md border border-border-primary bg-bg-secondary p-1.5 text-xs font-bold text-text-secondary transition-all hover:border-border-focus hover:bg-bg-tertiary hover:text-text-primary focus:outline-none"
    >
      {LANGUAGES.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {SHORT[lang.code]}
        </option>
      ))}
    </select>
  );
}
