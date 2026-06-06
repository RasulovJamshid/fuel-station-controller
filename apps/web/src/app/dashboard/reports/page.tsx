'use client';
import { useEffect, useState, useCallback } from 'react';
import { reportsApi } from '@/lib/api';
import { fmtVolume, fmtMoney } from '@/lib/format';
import { Header } from '@/components/layout/header';
import { RevenueChart } from '@/components/dashboard/revenue-chart';
import { Button } from '@/components/ui/button';

const PRESETS = [
  { label: '7 дней',  days: 7 },
  { label: '30 дней', days: 30 },
  { label: '90 дней', days: 90 },
];

export default function ReportsPage() {
  const [preset, setPreset]   = useState(30);
  const [revenue, setRevenue] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [operators, setOperators] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (days: number) => {
    setLoading(true);
    const from = new Date(Date.now() - days * 86_400_000).toISOString();
    const to   = new Date().toISOString();
    try {
      const [rev, prod, ops] = await Promise.all([
        reportsApi.revenue({ from, to, groupBy: 'day' }),
        reportsApi.products({ from, to }),
        reportsApi.operators({ from, to }),
      ]);
      setRevenue(Array.isArray(rev) ? rev : []);
      setProducts(Array.isArray(prod) ? prod : []);
      setOperators(Array.isArray(ops) ? ops : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(preset); }, [preset, load]);

  // Aggregate revenue by period
  const chartData = revenue.reduce((acc: any[], row: any) => {
    const ex = acc.find(a => a.period === row.period);
    if (ex) {
      ex.total_volume += row.total_volume ?? 0;
      ex.total_amount  = Number(ex.total_amount) + Number(row.total_amount ?? 0);
      ex.tx_count     += row.tx_count ?? 0;
    } else {
      acc.push({ ...row, total_volume: row.total_volume ?? 0, total_amount: Number(row.total_amount ?? 0), tx_count: row.tx_count ?? 0 });
    }
    return acc;
  }, []).sort((a, b) => a.period.localeCompare(b.period));

  return (
    <div className="animate-fade-in">
      <Header title="Отчёты" />

      <div className="p-2 sm:p-4 space-y-6">
        {/* Period selector */}
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map(p => (
            <Button
              key={p.days}
              size="sm"
              variant={preset === p.days ? 'primary' : 'outline'}
              onClick={() => setPreset(p.days)}
            >
              {p.label}
            </Button>
          ))}
        </div>

        {/* Revenue chart */}
        <RevenueChart data={chartData} loading={loading} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Products */}
          <div className="panel-subtle">
            <div className="panel-header">
              <h2 className="font-semibold text-slate-900">По продуктам</h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="table-head-row">
                  <th className="table-head-cell">Продукт</th>
                  <th className="table-head-cell text-right">Транзакций</th>
                  <th className="table-head-cell text-right">Объём</th>
                  <th className="table-head-cell text-right">Сумма</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {loading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i}>
                      {[1,2,3,4].map(j => (
                        <td key={j} className="table-cell">
                          <div className="h-4 bg-slate-100 rounded animate-pulse" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : products.map((p: any, i) => (
                  <tr key={i} className="table-row-hover">
                    <td className="table-cell font-medium text-slate-800">{p.productName}</td>
                    <td className="table-cell text-right text-slate-600">{p.tx_count}</td>
                    <td className="table-cell text-right font-mono text-slate-700">{fmtVolume(p.total_volume)}</td>
                    <td className="table-cell text-right font-mono text-slate-700 whitespace-nowrap">{fmtMoney(p.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Operators */}
          <div className="panel-subtle">
            <div className="panel-header">
              <h2 className="font-semibold text-slate-900">По операторам</h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="table-head-row">
                  <th className="table-head-cell">Оператор</th>
                  <th className="table-head-cell text-right">Транзакций</th>
                  <th className="table-head-cell text-right">Объём</th>
                  <th className="table-head-cell text-right">Сумма</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {loading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i}>
                      {[1,2,3,4].map(j => (
                        <td key={j} className="table-cell">
                          <div className="h-4 bg-slate-100 rounded animate-pulse" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : operators.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="table-cell py-8 text-center text-sm text-slate-400">Нет данных</td>
                  </tr>
                ) : operators.map((o: any, i) => (
                  <tr key={i} className="table-row-hover">
                    <td className="table-cell font-medium text-slate-800">{o.operatorName ?? '—'}</td>
                    <td className="table-cell text-right text-slate-600">{o.tx_count}</td>
                    <td className="table-cell text-right font-mono text-slate-700">{fmtVolume(o.total_volume)}</td>
                    <td className="table-cell text-right font-mono text-slate-700 whitespace-nowrap">{fmtMoney(o.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
