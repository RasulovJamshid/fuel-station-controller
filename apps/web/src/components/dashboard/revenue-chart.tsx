'use client';
import { useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { cn } from '@/lib/utils';
import { useFormats } from '@/hooks/use-formats';
import { useT } from '@/hooks/use-t';
import { useAuthStore } from '@/store/auth';

interface RevenuePoint {
  period: string;
  total_volume: number;
  total_amount: number;
  tx_count: number;
}

interface RevenueChartProps {
  data: RevenuePoint[];
  loading?: boolean;
}

type Mode = 'volume' | 'amount' | 'count';

function fmtY(v: number, mode: Mode, fmtVolume: (n: number) => string, fmtMoney: (n: number | bigint) => string) {
  if (mode === 'volume') return fmtVolume(v);
  if (mode === 'amount') return `${(v / 1_000_000).toFixed(1)} mln`;
  return String(v);
}

export function RevenueChart({ data, loading }: RevenueChartProps) {
  const t = useT();
  const { fmtDateShort, fmtVolume, fmtMoney } = useFormats();
  const [mode, setMode] = useState<Mode>('volume');

  const theme = useAuthStore(s => (s.user?.preferences as any)?.theme) ?? 'light';
  const isDark = theme === 'dark';

  const modes: { key: Mode; label: string }[] = [
    { key: 'volume', label: t('liters') },
    { key: 'amount', label: t('amount') },
    { key: 'count',  label: t('transactions') },
  ];

  const chartData = data.map(d => ({
    date:  fmtDateShort(d.period),
    value: mode === 'volume' ? d.total_volume
         : mode === 'amount' ? Number(d.total_amount)
         : d.tx_count,
  }));

  const gridColor = isDark ? '#27272a' : '#f1f5f9';
  const tickColor = isDark ? '#71717a' : '#94a3b8';

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 transition-all hover:shadow-md">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-slate-900">{t('salesDynamics')}</h2>
        <div className={cn('flex gap-1 rounded-lg p-1', isDark ? 'bg-zinc-800' : 'bg-slate-100')}>
          {modes.map(m => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-all',
                mode === m.key
                  ? isDark
                    ? 'bg-zinc-600 text-zinc-100 shadow-sm'
                    : 'bg-white text-slate-900 shadow-sm'
                  : isDark
                    ? 'text-zinc-400 hover:text-zinc-200'
                    : 'text-slate-500 hover:text-slate-900',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="h-48 flex items-center justify-center">
          <div className="h-full w-full bg-slate-50 rounded-lg animate-pulse" />
        </div>
      ) : data.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-slate-400 text-sm">
          {t('noChartData')}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: tickColor }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={v => fmtY(v, mode, fmtVolume, fmtMoney)}
              tick={{ fontSize: 11, fill: tickColor }}
              axisLine={false}
              tickLine={false}
              width={52}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#0f172a',
                border: 'none',
                borderRadius: '8px',
                fontSize: '12px',
                color: '#f1f5f9',
              }}
              formatter={(v: number) => [fmtY(v, mode, fmtVolume, fmtMoney), '']}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="#6366f1"
              strokeWidth={3}
              fill="url(#grad)"
              dot={false}
              activeDot={{ r: 6, fill: '#6366f1', strokeWidth: 2, stroke: '#fff', className: "drop-shadow-md" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
