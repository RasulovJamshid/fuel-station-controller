'use client';
import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Wifi, WifiOff, RefreshCw, Activity, Droplets,
  Receipt, Clock, AlertTriangle, CheckCircle, XCircle, Pause,
  TrendingUp, User,
} from 'lucide-react';
import { stationsApi } from '@/lib/api';
import { fmtVolume, fmtMoney, fmtDate, fmtRelative, fmtDuration } from '@/lib/format';
import { Header } from '@/components/layout/header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TxStatusBadge } from '@/components/ui/badge';

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

function TankGauge({ tank }: { tank: any }) {
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
      {tank.readingAt && (
        <p className="text-xs text-slate-300 mt-1">{fmtRelative(tank.readingAt)}</p>
      )}
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
  const { id } = useParams<{ id: string }>();
  const router  = useRouter();
  const [data, setData]     = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res: any = await stationsApi.detail(id);
      setData(res);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const isOnline = data?.station
    ? data.station.lastSyncAt && (Date.now() - new Date(data.station.lastSyncAt).getTime()) < 10 * 60_000
    : false;

  if (loading) {
    return (
      <div className="animate-fade-in">
        <Header title="Загрузка..." />
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
        <Header title="Ошибка" />
        <div className="p-6 flex flex-col items-center gap-4 py-16">
          <AlertTriangle size={40} className="text-red-400" />
          <p className="text-slate-500">{error || 'Станция не найдена'}</p>
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft size={16} /> Назад
          </Button>
        </div>
      </div>
    );
  }

  const { station, stats, transactions, prices, activeShift, healthEvents, tanks } = data;

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
            <ArrowLeft size={16} /> Все станции
          </button>
          <div className="flex items-center gap-3">
            <Badge variant={isOnline ? 'success' : 'neutral'}>
              {isOnline ? <><Wifi size={11} /> Онлайн</> : <><WifiOff size={11} /> Оффлайн</>}
            </Badge>
            {station.lastSyncAt && (
              <span className="text-xs text-slate-400">Синхр. {fmtRelative(station.lastSyncAt)}</span>
            )}
            <button
              onClick={load}
              disabled={loading}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <StatCard
            icon={Receipt}
            label="Транзакций сегодня"
            value={stats.todayTransactions}
            color="brand"
          />
          <StatCard
            icon={Droplets}
            label="Объём сегодня"
            value={fmtVolume(stats.todayVolume)}
            color="emerald"
          />
          <StatCard
            icon={TrendingUp}
            label="Выручка сегодня"
            value={fmtMoney(stats.todayAmount)}
            color="amber"
          />
          <StatCard
            icon={User}
            label="Активная смена"
            value={activeShift ? activeShift.operatorName : 'Нет'}
            sub={activeShift ? `Начата ${fmtRelative(activeShift.startedAt)}` : undefined}
            color={activeShift ? 'brand' : 'slate'}
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

          {/* Left column: transactions + prices */}
          <div className="xl:col-span-2 space-y-6">

            {/* Recent transactions */}
            <div className="panel-subtle overflow-hidden">
              <div className="panel-header">
                <h2 className="font-semibold text-slate-900">Последние транзакции</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="table-head-row">
                      <th className="table-head-cell">КЗ</th>
                      <th className="table-head-cell">Продукт</th>
                      <th className="table-head-cell text-right">Объём</th>
                      <th className="table-head-cell text-right">Сумма</th>
                      <th className="table-head-cell">Статус</th>
                      <th className="table-head-cell">Время</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {transactions.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="table-cell py-10 text-center text-sm text-slate-400">
                          Нет транзакций
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
            </div>

            {/* Current prices */}
            <div className="panel-subtle overflow-hidden">
              <div className="panel-header">
                <h2 className="font-semibold text-slate-900">Текущие цены</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="table-head-row">
                      <th className="table-head-cell">КЗ</th>
                      <th className="table-head-cell">Форсунка</th>
                      <th className="table-head-cell">Продукт</th>
                      <th className="table-head-cell text-right">Цена (тийин/л)</th>
                      <th className="table-head-cell">Обновлено</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {prices.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="table-cell py-8 text-center text-sm text-slate-400">
                          Цены не заданы
                        </td>
                      </tr>
                    ) : prices.map((p: any, i: number) => (
                      <tr key={i} className="table-row-hover">
                        <td className="table-cell font-medium text-slate-700">{p.fpId}</td>
                        <td className="table-cell text-slate-500">#{p.nozzleIndex}</td>
                        <td className="table-cell text-slate-700">{p.productName}</td>
                        <td className="table-cell text-right font-mono font-semibold text-slate-900">
                          {new Intl.NumberFormat('ru-UZ').format(p.price)}
                        </td>
                        <td className="table-cell text-xs text-slate-400">{fmtDate(p.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

          </div>

          {/* Right column: tanks + health events */}
          <div className="space-y-6">

            {/* Tank levels */}
            <div className="panel-subtle overflow-hidden">
              <div className="panel-header flex items-center gap-2">
                <Droplets size={15} className="text-blue-400" />
                <h2 className="font-semibold text-slate-900">Резервуары</h2>
              </div>
              <div className="p-4 space-y-3">
                {tanks.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-4">Резервуары не настроены</p>
                ) : tanks.map((t: any) => (
                  <TankGauge key={t.id} tank={t} />
                ))}
              </div>
            </div>

            {/* Active shift detail */}
            {activeShift && (
              <div className="panel-subtle overflow-hidden">
                <div className="panel-header flex items-center gap-2">
                  <Clock size={15} className="text-brand-400" />
                  <h2 className="font-semibold text-slate-900">Активная смена</h2>
                </div>
                <div className="p-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Оператор</span>
                    <span className="font-medium text-slate-800">{activeShift.operatorName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Начало</span>
                    <span className="text-slate-700">{fmtDate(activeShift.startedAt)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Длительность</span>
                    <span className="text-slate-700">{fmtDuration(activeShift.startedAt)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Транзакций</span>
                    <span className="font-medium text-slate-800">{activeShift.totalTransactions}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Объём</span>
                    <span className="font-mono text-slate-800">{fmtVolume(activeShift.totalVolume)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Сумма</span>
                    <span className="font-mono font-semibold text-slate-900">{fmtMoney(Number(activeShift.totalAmount))}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Health events */}
            <div className="panel-subtle overflow-hidden">
              <div className="panel-header flex items-center gap-2">
                <Activity size={15} className="text-slate-400" />
                <h2 className="font-semibold text-slate-900">События оборудования</h2>
              </div>
              <div className="divide-y divide-slate-50">
                {healthEvents.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-6">Нет событий</p>
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
