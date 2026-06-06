import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  color?: 'blue' | 'green' | 'purple' | 'orange';
  loading?: boolean;
}

const colorMap = {
  blue:   { icon: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',   bg: 'from-blue-500/5 to-transparent' },
  green:  { icon: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', bg: 'from-emerald-500/5 to-transparent' },
  purple: { icon: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',  bg: 'from-violet-500/5 to-transparent' },
  orange: { icon: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',  bg: 'from-orange-500/5 to-transparent' },
};

export function StatCard({ label, value, sub, icon: Icon, color = 'blue', loading }: StatCardProps) {
  const c = colorMap[color];
  return (
    <div className={cn(
      'panel group p-5 flex items-start gap-4 transition-all hover:shadow-md relative overflow-hidden',
    )}>
      <div className={cn("absolute inset-0 bg-gradient-to-br opacity-50 pointer-events-none", c.bg)} />
      <div className={cn('p-3 rounded-xl flex-shrink-0 z-10 transition-transform group-hover:scale-105', c.icon)}>
        <Icon size={20} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-slate-500 font-medium truncate">{label}</p>
        {loading ? (
          <div className="mt-1 h-7 w-24 bg-slate-100 rounded animate-pulse" />
        ) : (
          <p className="mt-0.5 text-2xl font-bold text-slate-900 leading-tight">{value}</p>
        )}
        {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
      </div>
    </div>
  );
}
