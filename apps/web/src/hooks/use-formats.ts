import { useAuthStore } from '@/store/auth';
import { createFormatters, Lang } from '@/lib/format';

const VALID_LANGS = new Set<string>(['ru', 'uz', 'en']);

export function useFormats() {
  const language = useAuthStore(s => (s.user?.preferences as any)?.language as string | undefined) ?? 'ru';
  const lang = (VALID_LANGS.has(language) ? language : 'ru') as Lang;
  return createFormatters(lang);
}
