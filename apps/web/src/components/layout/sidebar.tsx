'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, ArrowLeftRight, Gauge, BarChart3,
  Clock, Settings, LogOut, Fuel, Users,
  Droplets, DollarSign, Bell, Building2, Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';
import { useT } from '@/hooks/use-t';

export function Sidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  const path = usePathname();
  const { user, logout } = useAuthStore();
  const t = useT();

  const nav = [
    { href: '/dashboard',              label: t('navOverview'),      icon: LayoutDashboard },
    { href: '/dashboard/transactions', label: t('navTransactions'),  icon: ArrowLeftRight },
    { href: '/dashboard/shifts',       label: t('navShifts'),        icon: Clock },
    { href: '/dashboard/stations',     label: t('navStations'),      icon: Gauge },
    { href: '/dashboard/oil-bases',    label: t('navOilBases'),      icon: Building2 },
    { href: '/dashboard/tanks',        label: t('navTanks'),         icon: Droplets },
    { href: '/dashboard/prices',       label: t('navPrices'),        icon: DollarSign },
    { href: '/dashboard/reports',      label: t('navReports'),       icon: BarChart3 },
    { href: '/dashboard/alerts',       label: t('navAlerts'),        icon: Bell },
    { href: '/dashboard/integrations', label: t('navIntegrations'),  icon: Zap },
    { href: '/dashboard/users',        label: t('navUsers'),         icon: Users },
  ];

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 z-30 bg-black/40 transition-opacity lg:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
      />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-[#09090b] border-r border-slate-800 shadow-none transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full',
          'lg:translate-x-0',
        )}
      >
        {/* Logo */}
        <div className="flex h-16 items-center gap-3 px-5 border-b border-slate-800">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600">
            <Fuel className="h-5 w-5 text-white" />
          </div>
          <span className="font-semibold text-white tracking-wide">AZS Manager</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto scrollbar-thin px-3 py-4 space-y-0.5">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = href === '/dashboard' ? path === href : path.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                className={cn(
                  'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150',
                  active
                    ? 'text-white bg-slate-800/80 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50',
                )}
              >
                <Icon className={cn("h-4.5 w-4.5 flex-shrink-0 transition-colors", active ? "text-brand-400" : "text-slate-500 group-hover:text-slate-300")} size={18} />
                <span className="truncate">{label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Bottom */}
        <div className="border-t border-slate-800 p-3 space-y-1">
          <Link
            href="/dashboard/settings"
            onClick={onClose}
            className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-400 hover:bg-slate-800/50 hover:text-slate-200 transition-colors"
          >
            <Settings size={18} className="text-slate-500 group-hover:text-slate-300 transition-colors" />
            {t('navSettings')}
          </Link>
          <button
            onClick={() => { logout(); onClose?.(); }}
            className="group w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
          >
            <LogOut size={18} className="text-slate-500 group-hover:text-red-400 transition-colors" />
            {t('logout')}
          </button>

          {user && (
            <div className="mt-2 flex items-center gap-3 px-3 py-2.5">
              <div className="h-8 w-8 rounded-md bg-slate-800 flex items-center justify-center text-slate-300 font-medium text-sm flex-shrink-0 border border-slate-700">
                {user.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-200 truncate">{user.name}</p>
                <p className="text-xs text-slate-500 truncate">{user.role}</p>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
