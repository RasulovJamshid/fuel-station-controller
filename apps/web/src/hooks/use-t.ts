import { useAuthStore } from '@/store/auth';
import { messages, Lang, TranslationKey } from '@/lib/i18n';

export function useT() {
  const language = useAuthStore(s => (s.user?.preferences as any)?.language as string | undefined) ?? 'ru';
  const lang: Lang = (language in messages ? language : 'ru') as Lang;
  const dict = messages[lang];
  return (key: TranslationKey): string => (dict as any)[key] ?? (messages.ru as any)[key] ?? key;
}
