'use client';
import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Fuel, Mail, Lock, AlertCircle } from 'lucide-react';
import { authApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function LoginPage() {
  const router = useRouter();
  const { setTokens, setUser } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res: any = await authApi.login(email, password);
      setTokens(res.accessToken, res.refreshToken);
      const me: any = await authApi.me();
      setUser(me);
      router.replace('/dashboard');
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Неверный логин или пароль');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen relative flex items-center justify-center p-4 overflow-hidden bg-slate-50">
      <div
        className="absolute inset-0 z-0 opacity-[0.03]"
        style={{
          backgroundImage: 'linear-gradient(#000 1px, transparent 1px), linear-gradient(90deg, #000 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />

      <div className="relative z-10 w-full max-w-md animate-slide-up">
        {/* Card */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-xl overflow-hidden">
          <div className="px-8 py-10">
            {/* Logo */}
            <div className="flex flex-col items-center mb-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-900 shadow-sm mb-6">
                <Fuel className="h-6 w-6 text-white" />
              </div>
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight">AZS Manager</h1>
              <p className="mt-2 text-sm text-slate-500 font-medium">Управление топливными станциями</p>
            </div>

            {/* Form */}
            <form onSubmit={onSubmit} className="space-y-5">
              <div className="space-y-4">
                <Input
                  label="Email"
                  type="email"
                  placeholder="admin@ung.uz"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  icon={<Mail size={16} />}
                />
                <Input
                  label="Пароль"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  icon={<Lock size={16} />}
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2.5 text-sm text-red-600">
                  <AlertCircle size={16} className="flex-shrink-0" />
                  {error}
                </div>
              )}

              <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full mt-4 py-2.5">
                Войти
              </Button>
            </form>
          </div>
        </div>

        <p className="mt-8 text-center text-xs font-medium text-slate-400">
          UNG Fuel Network <span className="mx-2 opacity-30">•</span> Central Management System
        </p>
      </div>
    </div>
  );
}
