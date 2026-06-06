'use client';
import { useState, FormEvent } from 'react';
import { User, Lock, CheckCircle } from 'lucide-react';
import { authApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Header } from '@/components/layout/header';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div className="panel-subtle">
      <div className="panel-header flex items-center gap-2.5 bg-slate-50/50">
        <Icon size={16} className="text-slate-400" />
        <h2 className="font-semibold text-slate-900">{title}</h2>
      </div>
      <div className="px-4 sm:px-6 py-4 sm:py-5">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const { user } = useAuthStore();

  // Password form
  const [currentPw, setCurrentPw]   = useState('');
  const [newPw, setNewPw]           = useState('');
  const [confirmPw, setConfirmPw]   = useState('');
  const [pwLoading, setPwLoading]   = useState(false);
  const [pwError, setPwError]       = useState('');
  const [pwSuccess, setPwSuccess]   = useState(false);

  async function handlePasswordChange(e: FormEvent) {
    e.preventDefault();
    setPwError('');
    setPwSuccess(false);
    if (newPw !== confirmPw) { setPwError('Пароли не совпадают'); return; }
    if (newPw.length < 8)    { setPwError('Минимум 8 символов'); return; }
    setPwLoading(true);
    try {
      await authApi.changePassword(currentPw, newPw);
      setPwSuccess(true);
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } catch (err: any) {
      setPwError(err?.response?.data?.message ?? 'Ошибка смены пароля');
    } finally {
      setPwLoading(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <Header title="Настройки" />

      <div className="p-2 sm:p-4 space-y-6 w-full">

        {/* Profile */}
        <Section title="Профиль" icon={User}>
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="h-16 w-16 rounded-full bg-gradient-to-br from-brand-500/20 to-brand-600/20 shadow-sm border border-brand-500/10 flex items-center justify-center text-brand-600 font-bold text-2xl flex-shrink-0">
              {user?.name?.charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="font-semibold text-slate-900 text-base sm:text-lg">{user?.name}</p>
              <p className="text-sm text-slate-500">{user?.email}</p>
              <span className="mt-1 inline-block text-xs bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full font-medium">
                {user?.role?.replace('_', ' ')}
              </span>
            </div>
          </div>
        </Section>

        {/* Change password */}
        <Section title="Сменить пароль" icon={Lock}>
          <form onSubmit={handlePasswordChange} className="space-y-4">
            <Input
              label="Текущий пароль"
              type="password"
              value={currentPw}
              onChange={e => setCurrentPw(e.target.value)}
              required
              autoComplete="current-password"
            />
            <Input
              label="Новый пароль"
              type="password"
              value={newPw}
              onChange={e => setNewPw(e.target.value)}
              required
              autoComplete="new-password"
            />
            <Input
              label="Подтвердите новый пароль"
              type="password"
              value={confirmPw}
              onChange={e => setConfirmPw(e.target.value)}
              required
              error={pwError}
            />

            {pwSuccess && (
              <div className="flex items-center gap-2 text-sm text-emerald-600 bg-emerald-50 rounded-lg px-3 py-2.5">
                <CheckCircle size={16} />
                Пароль успешно изменён
              </div>
            )}

            <div className="flex justify-end">
              <Button type="submit" loading={pwLoading}>
                Сохранить пароль
              </Button>
            </div>
          </form>
        </Section>
      </div>
    </div>
  );
}
