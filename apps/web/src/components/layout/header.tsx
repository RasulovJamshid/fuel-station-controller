'use client';
import { Bell, Sun, Moon, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';
import { useT } from '@/hooks/use-t';

interface HeaderProps {
  title: string;
  subtitle?: string;
  connected?: boolean;
}

export function Header({ title, subtitle, connected }: HeaderProps) {
  const { user, setUser } = useAuthStore();
  const t = useT();

  const theme    = (user?.preferences as any)?.theme    || 'light';
  const language = (user?.preferences as any)?.language || 'ru';

  const toggleTheme = () => {
    if (!user) return;
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setUser({ ...user, preferences: { ...(user.preferences as any), theme: newTheme } } as any);
  };

  const toggleLang = () => {
    if (!user) return;
    const langs = ['ru', 'uz', 'en'];
    const next = langs[(langs.indexOf(language) + 1) % langs.length];
    setUser({ ...user, preferences: { ...(user.preferences as any), language: next } } as any);
  };

  return (
    <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 sm:gap-4 px-2 sm:px-4 pt-3 sm:pt-4 pb-2">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">{title}</h1>
        {subtitle && <p className="text-xs sm:text-sm text-slate-500 font-medium mt-1">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        {/* Live indicator */}
        <div className="flex items-center gap-1.5">
          <span className={cn(
            'h-2 w-2 rounded-full',
            connected ? 'bg-emerald-400 animate-pulse_dot' : 'bg-slate-300',
          )} />
          <span className="text-xs text-slate-500">{connected ? t('live') : t('offline')}</span>
        </div>

        <button
          onClick={toggleLang}
          className="icon-button flex items-center gap-1.5 uppercase text-xs font-medium"
        >
          <Globe size={18} />
          {language}
        </button>

        <button onClick={toggleTheme} className="icon-button">
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <button className="icon-button">
          <Bell size={18} />
        </button>
      </div>
    </header>
  );
}
