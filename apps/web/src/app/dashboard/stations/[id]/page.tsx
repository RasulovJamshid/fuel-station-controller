'use client';
import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Wifi, WifiOff, RefreshCw, Activity, Droplets,
  Receipt, Clock, AlertTriangle, CheckCircle, XCircle,
  TrendingUp, User,
  DollarSign, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { stationsApi, transactionsApi } from '@/lib/api';
import { useFormats } from '@/hooks/use-formats';
import { useT } from '@/hooks/use-t';
import { Header } from '@/components/layout/header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TxStatusBadge } from '@/components/ui/badge';
import Link from 'next/link';

function StatCard({ icon: Icon, label, value, sub, color = 'brand' }: {
  icon: any; label: string; value: string | number; sub?: string; color?: string;
}) {
  const colors: Record<string, string> = {
    brand:   'bg-brand-50 text-brand-600 border-brand-100',
    emerald: 'bg-emerald-50 text-emerald-600 border-emerald-100',
    amber:   'bg-amber-50 text-amber-600 border-amber-100',
    slate:   'bg-slate-50 text-slate-500 border-slate-100',
  };
  return (
    <div className="panel-subtle flex items-center gap-4 p-5">
      <div className={`h-12 w-12 rounded-2xl flex items-center justify-center flex-shrink-0 border ${colors[color] ?? colors.brand}`}>
        <Icon size={20} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
        <p className="text-xl font-bold text-slate-900 truncate">{value}</p>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function TankGauge({ tank, fmtVolume }: { tank: any; fmtVolume: (n: number) => string }) {
  const pct = Math.max(0, Math.min(100, tank.fillPercent ?? 0));
  const color = pct < 15 ? 'bg-red-500' : pct < 30 ? 'bg-amber-400' : 'bg-emerald-400';
  const textColor = pct < 15 ? 'text-red-600' : pct < 30 ? 'text-amber-600' : 'text-emerald-600';
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-medium text-slate-800">{tank.label}</p>
        <span className={`text-sm font-bold ${textColor}`}>
          {tank.fillPercent != null ? `${pct.toFixed(0)}%` : '—'}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden mb-2">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-xs text-slate-400">
        <span>{tank.productName}</span>
        <span>{tank.volumeLitres != null ? fmtVolume(tank.volumeLitres) : '—'} / {fmtVolume(tank.capacity)}</span>
      </div>
    </div>
  );
}

const HEALTH_ICON: Record<string, any> = {
  offline: XCircle,
  online:  CheckCircle,
};
const HEALTH_COLOR: Record<string, string> = {
  offline: 'text-red-500',
  online:  'text-emerald-500',
};

export default function StationDetailPage() {
  const t = useT();
  const { fmtVolume, fmtMoney, fmtDate, fmtRelative, fmtDuration } = useFormats();
  const { id } = useParams<{ id: string }>();
  const router  = useRouter();
  const [data, setData]     = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [transactions, setTransactions] = useState<any[]>([]);
  const [txPage, setTxPage] = useState(1);
  const [txPages, setTxPages] = useState(1);
  const [txTotal, setTxTotal] = useState(0);
  const [txLoading, setTxLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res: any = await stationsApi.detail(id);
      setData(res);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const loadTransactions = useCallback(async (page: number) => {
    setTxLoading(true);
    try {
      const response: any = await transactionsApi.list({ stationId: id, page, limit: 20 });
      setTransactions(response.data ?? []);
      setTxTotal(response.total ?? 0);
      setTxPages(Math.max(1, response.pages ?? 1));
    } finally {
      setTxLoading(false);
    }
  }, [id]);

  useEffect(() => { setTxPage(1); }, [id]);
  useEffect(() => { loadTransactions(txPage); }, [loadTransactions, txPage]);

  const isOnline = data?.station
    ? data.station.lastSyncAt && (Date.now() - new Date(data.station.lastSyncAt).getTime()) < 10 * 60_000
    : false;

  if (loading) {
    return (
      <div className="animate-fade-in">
        <Header title={t('loading')} />
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="panel-subtle p-5 h-24 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="animate-fade-in">
        <Header title={t('error')} />
        <div className="p-6 flex flex-col items-center gap-4 py-16">
          <AlertTriangle size={40} className="text-red-400" />
          <p className="text-slate-500">{error || t('stationNotFound')}</p>
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft size={16} /> {t('back')}
          </Button>
        </div>
      </div>
    );
  }

  const { station, stats, prices, activeShift, healthEvents, tanks } = data;
  const productPrices = Array.from(prices.reduce((groups: Map<string, any>, price: any) => {
    const key = price.canonicalProductId ?? `${price.productId}:${price.productName}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...price, minPrice: price.price, maxPrice: price.price, nozzleCount: 1 });
    } else {
      existing.minPrice = Math.min(existing.minPrice, price.price);
      existing.maxPrice = Math.max(existing.maxPrice, price.price);
      existing.nozzleCount += 1;
      if (new Date(price.updatedAt) > new Date(existing.updatedAt)) {
        Object.assign(existing, { ...price, minPrice: existing.minPrice, maxPrice: existing.maxPrice, nozzleCount: existing.nozzleCount });
      }
    }
    return groups;
  }, new Map<string, any>()).values());

  return (
    <div className="animate-fade-in">
      <Header
        title={station.name}
        subtitle={station.address ?? station.id}
        connected={isOnline}
      />

      <div className="p-2 sm:p-4 space-y-6">

        {/* Back + refresh */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 transition-colors"
          >
            <ArrowLeft size={16} /> {t('allStations')}
          </button>
          <div className="flex items-center gap-3">
            <Badge variant={isOnline ? 'success' : 'neutral'}>
              {isOnline ? <><Wifi size={11} /> {t('online')}</> : <><WifiOff size={11} /> {t('offline')}</>}
            </Badge>
            {station.lastSyncAt && (
              <span className="text-xs text-slate-400">{t('syncAt')} {fmtRelative(station.lastSyncAt)}</span>
            )}
            <button
              onClick={() => { load(); loadTransactions(txPage); }}
              disabled={loading || txLoading}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <RefreshCw size={15} className={loading || txLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <StatCard icon={Receipt}    label={t('todayTransactionsLabel')} value={stats.todayTransactions} color="brand" />
          <StatCard icon={Droplets}   label={t('todayVolumeLabel')}       value={fmtVolume(stats.todayVolume)}  color="emerald" />
          <StatCard icon={TrendingUp} label={t('todayRevenueLabel')}      value={fmtMoney(stats.todayAmount)}   color="amber" />
          <StatCard
            icon={User}
            label={t('activeShift')}
            value={activeShift ? activeShift.operatorName : t('noActiveShift')}
            sub={activeShift ? `${t('startedAt')} ${fmtRelative(activeShift.startedAt)}` : undefined}
            color={activeShift ? 'brand' : 'slate'}
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

          {/* Left column: transactions */}
          <div className="xl:col-span-2 space-y-6">

            {/* Paginated transactions */}
            <div className="panel-subtle overflow-hidden">
              <div className="panel-header flex items-center justify-between">
                <h2 className="font-semibold text-slate-900">{t('transactions')}</h2>
                <span className="text-xs text-slate-400">{txTotal} {t('records')}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="table-head-row">
                      <th className="table-head-cell">{t('fp')}</th>
                      <th className="table-head-cell">{t('product')}</th>
                      <th className="table-head-cell text-right">{t('volume')}</th>
                      <th className="table-head-cell text-right">{t('amount')}</th>
                      <th className="table-head-cell">{t('status')}</th>
                      <th className="table-head-cell">{t('time')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {txLoading ? (
                      Array.from({ length: 6 }).map((_, i) => (
                        <tr key={i}>
                          {Array.from({ length: 6 }).map((__, j) => (
                            <td key={j} className="table-cell"><div className="h-4 w-20 rounded bg-slate-100 animate-pulse" /></td>
                          ))}
                        </tr>
                      ))
                    ) : transactions.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="table-cell py-10 text-center text-sm text-slate-400">
                          {t('noTxFound')}
                        </td>
                      </tr>
                    ) : transactions.map((tx: any) => (
                      <tr key={tx.id} className="table-row-hover">
                        <td className="table-cell font-medium text-slate-700">{tx.label}</td>
                        <td className="table-cell text-slate-600">{tx.productName}</td>
                        <td className="table-cell text-right font-mono text-slate-700">{fmtVolume(tx.volume)}</td>
                        <td className="table-cell text-right font-mono text-slate-800">{fmtMoney(tx.amount)}</td>
                        <td className="table-cell"><TxStatusBadge status={tx.status} /></td>
                        <td className="table-cell text-xs text-slate-400 whitespace-nowrap">{fmtDate(tx.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 bg-slate-50">
                <p className="text-xs text-slate-500">{t('showing')} {transactions.length} {t('of')} {txTotal}</p>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={txPage <= 1 || txLoading} onClick={() => setTxPage(page => page - 1)}>
                    <ChevronLeft size={14} />
                  </Button>
                  <span className="text-sm text-slate-700">{txPage} / {txPages}</span>
                  <Button variant="outline" size="sm" disabled={txPage >= txPages || txLoading} onClick={() => setTxPage(page => page + 1)}>
                    <ChevronRight size={14} />
                  </Button>
                </div>
              </div>
            </div>

          </div>

          {/* Right column: tanks + health events */}
          <div className="space-y-6">

            {/* Product prices */}
            <div className="panel-subtle overflow-hidden">
              <div className="panel-header flex items-center gap-2">
                <DollarSign size={15} className="text-emerald-500" />
                <h2 className="font-semibold text-slate-900">{t('productPrices')}</h2>
              </div>
              <div className="p-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-3">
                {productPrices.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-4">{t('pricesNotSet')}</p>
                ) : productPrices.map((price: any) => (
                  <div key={price.canonicalProductId ?? `${price.productId}:${price.productName}`} className="rounded-xl border border-slate-100 bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-900 truncate">{price.canonicalProductName ?? price.productName}</p>
                        {price.canonicalProductName && <p className="text-xs text-slate-400 truncate">{price.productName}</p>}
                      </div>
                      <p className="font-mono font-bold text-emerald-700 whitespace-nowrap">
                        {price.minPrice === price.maxPrice
                          ? new Intl.NumberFormat('ru-UZ').format(price.price)
                          : `${new Intl.NumberFormat('ru-UZ').format(price.minPrice)}–${new Intl.NumberFormat('ru-UZ').format(price.maxPrice)}`}
                      </p>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                      <span>{price.nozzleCount} {t('nozzlesShort')}</span>
                      <span>{price.source === 'transaction' ? t('observedTransaction') : fmtRelative(price.updatedAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Tank levels */}
            <div className="panel-subtle overflow-hidden">
              <div className="panel-header flex items-center gap-2">
                <Droplets size={15} className="text-blue-400" />
                <h2 className="font-semibold text-slate-900">{t('tanks')}</h2>
              </div>
              <div className="p-4 space-y-3">
                {tanks.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-4">{t('noTanks')}</p>
                ) : tanks.map((tank: any) => (
                  <TankGauge key={tank.id} tank={tank} fmtVolume={fmtVolume} />
                ))}
              </div>
            </div>

            {/* Active shift detail */}
            {activeShift && (
              <div className="panel-subtle overflow-hidden">
                <div className="panel-header flex items-center gap-2">
                  <Clock size={15} className="text-brand-400" />
                  <h2 className="font-semibold text-slate-900">{t('activeShift')}</h2>
                  <Link href={`/dashboard/shifts/${activeShift.id}`} className="ml-auto text-xs font-medium text-brand-600 hover:text-brand-700">
                    {t('details')}
                  </Link>
                </div>
                <div className="p-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">{t('operator')}</span>
                    <span className="font-medium text-slate-800">{activeShift.operatorName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">{t('start')}</span>
                    <span className="text-slate-700">{fmtDate(activeShift.startedAt)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">{t('duration')}</span>
                    <span className="text-slate-700">{fmtDuration(activeShift.startedAt)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">{t('totalTx')}</span>
                    <span className="font-medium text-slate-800">{activeShift.totalTransactions}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">{t('totalVolume')}</span>
                    <span className="font-mono text-slate-800">{fmtVolume(activeShift.totalVolume)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">{t('totalAmount')}</span>
                    <span className="font-mono font-semibold text-slate-900">{fmtMoney(Number(activeShift.totalAmount))}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Health events */}
            <div className="panel-subtle overflow-hidden">
              <div className="panel-header flex items-center gap-2">
                <Activity size={15} className="text-slate-400" />
                <h2 className="font-semibold text-slate-900">{t('healthEvents')}</h2>
              </div>
              <div className="divide-y divide-slate-50">
                {healthEvents.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-6">{t('noEvents')}</p>
                ) : healthEvents.map((e: any) => {
                  const Icon = HEALTH_ICON[e.eventType] ?? AlertTriangle;
                  const color = HEALTH_COLOR[e.eventType] ?? 'text-amber-500';
                  return (
                    <div key={e.id} className="flex items-start gap-3 px-4 py-3">
                      <Icon size={16} className={`mt-0.5 flex-shrink-0 ${color}`} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-700 capitalize">
                          {e.eventType.replace(/_/g, ' ')}
                          {e.fpId && <span className="text-slate-400 font-normal"> · {e.fpId}</span>}
                        </p>
                        {e.detail && <p className="text-xs text-slate-400 truncate">{e.detail}</p>}
                        <p className="text-xs text-slate-300 mt-0.5">{fmtRelative(e.occurredAt)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
