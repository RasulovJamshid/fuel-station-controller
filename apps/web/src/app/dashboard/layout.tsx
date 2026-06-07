'use client';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Menu } from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { useAuthStore } from '@/store/auth';
import { ToastProvider } from '@/components/ui/toast';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const token = useAuthStore(s => s.token);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isSidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const user = useAuthStore(s => s.user);
  const theme = (user?.preferences as any)?.theme || 'light';

  useEffect(() => {
    if (isHydrated && !token) router.replace('/login');
  }, [isHydrated, token, router]);

  useEffect(() => {
    if (!isHydrated) return;
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme, isHydrated]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  if (!isHydrated || !token) return null;

  return (
    <ToastProvider>
      <div className="flex h-screen overflow-hidden transition-colors duration-300">
        <Sidebar open={isSidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="relative flex flex-1 flex-col overflow-hidden lg:ml-64">
          <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-slate-200 bg-slate-50/95 px-3 py-2 backdrop-blur lg:hidden">
            <button
              onClick={() => setSidebarOpen(true)}
              className="icon-button"
              aria-label="Открыть меню"
            >
              <Menu size={18} />
            </button>
            <span className="text-sm font-semibold text-slate-700">AZS Manager</span>
          </div>
          <main className="flex-1 overflow-y-auto scrollbar-thin">
            <div className="w-full px-3 sm:px-6 lg:px-8 py-4 sm:py-6">
              {children}
            </div>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
