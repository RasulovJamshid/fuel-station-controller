'use client';
import { cn } from '@/lib/utils';
import { useT } from '@/hooks/use-t';

type Variant = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const styles: Record<Variant, string> = {
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  danger:  'bg-red-50 text-red-700 border-red-200',
  info:    'bg-blue-50 text-blue-700 border-blue-200',
  neutral: 'bg-slate-100 text-slate-700 border-slate-200',
};

interface BadgeProps {
  variant?: Variant;
  children: React.ReactNode;
  className?: string;
}

export function Badge({ variant = 'neutral', children, className }: BadgeProps) {
  return (
    <span className={cn('badge', styles[variant], className)}>
      {children}
    </span>
  );
}

export function StatusDot({ online }: { online: boolean }) {
  return (
    <span className={cn('inline-block w-2 h-2 rounded-full', online ? 'bg-emerald-400' : 'bg-slate-400')} />
  );
}

export function TxStatusBadge({ status }: { status: string }) {
  const t = useT();
  const map: Record<string, Variant> = {
    COMPLETED: 'success',
    STOPPED:   'warning',
    ABORTED:   'danger',
  };
  const labels: Record<string, string> = {
    COMPLETED: t('completed'),
    STOPPED:   t('stopped'),
    ABORTED:   t('aborted'),
  };
  return <Badge variant={map[status] ?? 'neutral'}>{labels[status] ?? status}</Badge>;
}
