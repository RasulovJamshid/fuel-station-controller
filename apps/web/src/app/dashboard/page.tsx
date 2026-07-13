'use client';
import { useEffect, useState, useCallback } from 'react';
import { Droplets, Receipt, Gauge } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { dashboardApi, transactionsApi, reportsApi } from '@/lib/api';
import { useFormats } from '@/hooks/use-formats';
import { useT } from '@/hooks/use-t';
import { useWebSocket } from '@/hooks/use-websocket';
import { Header } from '@/components/layout/header';
import { StatCard } from '@/components/dashboard/stat-card';
import { RevenueChart } from '@/components/dashboard/revenue-chart';
import { TxStatusBadge, StatusDot } from '@/components/ui/badge';

export default function OverviewPage() {
  const t = useT();
  const { fmtVolume, fmtMoney, fmtDate } = useFormats();

  const [overview, setOverview] = useState<any>(null);
  const [recent, setRecent]     = useState<any[]>([]);
  const [chart, setChart]       = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);

  const load = useCallback(async () => {
    try {
      const [ov, tx, rev] = await Promise.allSettled([
        dashboardApi.overview(),
        transactionsApi.list({ limit: 10, status: ['COMPLETED', 'STOPPED'] }),
        reportsApi.revenue({
          from: new Date(Date.now() - 29 * 86_400_000).toISOString(),
          to:   new Date().toISOString(),
          groupBy: 'day',
        }),
      ]);
      if (ov.status === 'fulfilled') setOverview(ov.value);
      if (tx.status === 'fulfilled') setRecent((tx.value as any).data ?? []);
      if (rev.status === 'fulfilled') setChart(Array.isArray(rev.value) ? rev.value : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const { connected } = useWebSocket(useCallback((ev: string) => {
    if (ev === 'transaction.synced') load();
  }, [load]));

  const today = format(new Date(), 'EEEE, d MMMM yyyy', { locale: ru });

  const chartAgg = chart.reduce((acc: any[], row: any) => {
    const ex = acc.find(a => a.period === row.period);
    if (ex) {
      ex.total_volume += row.total_volume ?? 0;
      ex.total_amount = (Number(ex.total_amount) + Number(row.total_amount ?? 0));
      ex.tx_count    += row.tx_count ?? 0;
    } else {
      acc.push({ ...row, total_volume: row.total_volume ?? 0, total_amount: Number(row.total_amount ?? 0), tx_count: row.tx_count ?? 0 });
    }
    return acc;
  }, []).sort((a, b) => a.period.localeCompare(b.period));

  return (
    <div className="animate-fade-in">
      <Header title={t('navOverview')} subtitle={today} connected={connected} />

      <div className="p-2 space-y-6">
        {/* KPI cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            label={t('todayVolume')}
            value={loading ? '—' : fmtVolume(overview?.todayVolume ?? 0)}
            icon={Droplets}
            color="blue"
            loading={loading}
          />
          <StatCard
            label={t('todayTransactions')}
            value={loading ? '—' : String(overview?.todayTransactions ?? 0)}
            icon={Receipt}
            color="green"
            loading={loading}
          />
          <StatCard
            label={t('stationsOnline')}
            value={loading ? '—' : String(overview?.stationsOnline ?? overview?.stations ?? 0)}
            icon={Gauge}
            color="purple"
            loading={loading}
          />
        </div>

        {/* Chart + Stations */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <RevenueChart data={chartAgg} loading={loading} />
          </div>

          {/* Station status */}
          <div className="panel p-5 flex flex-col min-h-0">
            <h2 className="font-semibold text-slate-900 mb-3">{t('stations')}</h2>
            {loading ? (
              <div className="space-y-2">
                {[1,2,3].map(i => (
                  <div key={i} className="h-12 bg-slate-50 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[330px] overflow-y-auto pr-1">
                {(overview?.stationSummaries ?? []).map((s: any) => {
                  const lag = s.lastSyncAt
                    ? (Date.now() - new Date(s.lastSyncAt).getTime()) / 60_000
                    : Infinity;
                  const online = lag < 10;
                  return (
                    <div key={s.id} className="group flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-50 hover:shadow-sm transition-all duration-200 border border-transparent hover:border-slate-200">
                      <StatusDot online={online} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{s.name}</p>
                        <p className="text-xs text-slate-400">
                          {s.lastSyncAt ? `${Math.round(lag)} ${t('minAgo')}` : t('noSync')}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Recent transactions */}
        <div className="panel-subtle">
          <div className="panel-header flex items-center justify-between">
            <h2 className="font-semibold text-slate-900 text-lg">{t('recentTransactions')}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="table-head-row">
                  {[t('time'), t('station'), t('fp'), t('product'), t('volume'), t('amount'), t('status')].map(h => (
                    <th key={h} className="table-head-cell">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 7 }).map((_, j) => (
                        <td key={j} className="table-cell">
                          <div className="h-4 bg-slate-100 rounded animate-pulse w-20" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : recent.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="table-cell py-8 text-center text-sm text-slate-400">
                      {t('noTransactions')}
                    </td>
                  </tr>
                ) : (
                  recent.map((tx: any) => (
                    <tr key={tx.id} className="table-row-hover group">
                      <td className="table-cell text-slate-500 whitespace-nowrap text-xs">{fmtDate(tx.startedAt)}</td>
                      <td className="table-cell font-medium text-slate-800">{tx.stationId}</td>
                      <td className="table-cell text-slate-500">{tx.label}</td>
                      <td className="table-cell text-slate-700">{tx.productName}</td>
                      <td className="table-cell text-slate-700 font-mono">{fmtVolume(tx.volume)}</td>
                      <td className="table-cell text-slate-700 font-mono whitespace-nowrap">{fmtMoney(tx.amount)}</td>
                      <td className="table-cell"><TxStatusBadge status={tx.status} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
