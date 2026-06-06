'use client';
import { useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { cn } from '@/lib/utils';
import { fmtDateShort } from '@/lib/format';

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

const modes: { key: Mode; label: string }[] = [
  { key: 'volume', label: 'Литры' },
  { key: 'amount', label: 'Сумма' },
  { key: 'count',  label: 'Транзакции' },
];

function fmtY(v: number, mode: Mode) {
  if (mode === 'volume') return `${(v / 1000).toFixed(1)} м³`;
  if (mode === 'amount') return `${(v / 100_000_000).toFixed(1)} млн`;
  return String(v);
}

export function RevenueChart({ data, loading }: RevenueChartProps) {
  const [mode, setMode] = useState<Mode>('volume');

  const chartData = data.map(d => ({
    date:  fmtDateShort(d.period),
    value: mode === 'volume' ? d.total_volume
         : mode === 'amount' ? Number(d.total_amount)
         : d.tx_count,
  }));

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 transition-all hover:shadow-md">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-slate-900">Динамика продаж</h2>
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          {modes.map(m => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-all',
                mode === m.key
                  ? 'bg-white text-slate-900 shadow-sm'
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
          Нет данных
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
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: '#94a3b8' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={v => fmtY(v, mode)}
              tick={{ fontSize: 11, fill: '#94a3b8' }}
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
              formatter={(v: number) => [fmtY(v, mode), '']}
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
