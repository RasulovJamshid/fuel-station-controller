'use client';
import { useEffect, useState, useCallback } from 'react';
import { Droplets, RefreshCw, AlertTriangle } from 'lucide-react';
import { reservoirsApi } from '@/lib/api';
import { Header } from '@/components/layout/header';
import { useWebSocket } from '@/hooks/use-websocket';
import { cn } from '@/lib/utils';

function TankGauge({ percent }: { percent: number | null }) {
  const pct = Math.max(0, Math.min(100, percent ?? 0));
  const color = pct < 15 ? 'bg-red-500' : pct < 30 ? 'bg-amber-400' : 'bg-emerald-400';
  return (
    <div className="mt-3">
      <div className="flex justify-between text-xs text-slate-500 mb-1">
        <span>Уровень</span>
        <span className={cn('font-semibold', pct < 15 ? 'text-red-600' : pct < 30 ? 'text-amber-600' : 'text-emerald-600')}>
          {percent != null ? `${pct.toFixed(0)}%` : '—'}
        </span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
        <div className={cn('h-full rounded-full transition-all duration-700', color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function TanksPage() {
  const [tanks, setTanks]   = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await reservoirsApi.latest();
      setTanks(Array.isArray(res) ? res : []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const { connected } = useWebSocket(useCallback((ev: string) => {
    if (ev === 'tank.updated') load();
  }, [load]));

  return (
    <div className="animate-fade-in">
      <Header title="Резервуары" subtitle={`${tanks.length} резервуаров`} connected={connected} />

      <div className="p-6">
        <div className="flex justify-end mb-4">
          <button onClick={load} disabled={loading} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 transition-colors">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Обновить
          </button>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="bg-white rounded-xl shadow-card p-5 h-40 animate-pulse" />)}
          </div>
        ) : tanks.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-slate-400">
            <Droplets size={40} className="mb-3 opacity-30" />
            <p>Резервуары не найдены</p>
            <p className="text-xs mt-1">Данные появятся после первой синхронизации ATG</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {tanks.map((t: any) => {
              const pct = t.fillPercent;
              const isLow = pct != null && pct < 20;
              return (
                <div key={t.id} className={cn('bg-white rounded-xl shadow-card p-5 border-l-4', isLow ? 'border-l-red-400' : 'border-l-slate-200')}>
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold text-slate-900">{t.label}</h3>
                      <p className="text-xs text-slate-400 mt-0.5">{t.productName}</p>
                    </div>
                    <div className={cn('p-2 rounded-lg', isLow ? 'bg-red-50 text-red-500' : 'bg-blue-50 text-blue-500')}>
                      {isLow ? <AlertTriangle size={16} /> : <Droplets size={16} />}
                    </div>
                  </div>

                  <TankGauge percent={pct} />

                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-slate-50 rounded-lg p-2">
                      <p className="text-slate-400">Объём</p>
                      <p className="font-semibold text-slate-800 mt-0.5">
                        {t.volumeLitres != null ? `${t.volumeLitres.toFixed(0)} л` : '—'}
                      </p>
                    </div>
                    <div className="bg-slate-50 rounded-lg p-2">
                      <p className="text-slate-400">Ёмкость</p>
                      <p className="font-semibold text-slate-800 mt-0.5">
                        {t.capacity != null ? `${t.capacity.toFixed(0)} л` : '—'}
                      </p>
                    </div>
                    {t.temperatureC != null && (
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-400">Температура</p>
                        <p className="font-semibold text-slate-800 mt-0.5">{t.temperatureC.toFixed(1)}°C</p>
                      </div>
                    )}
                    {t.levelMm != null && (
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-400">Уровень</p>
                        <p className="font-semibold text-slate-800 mt-0.5">{t.levelMm.toFixed(0)} мм</p>
                      </div>
                    )}
                  </div>

                  <p className="text-xs text-slate-400 mt-2">
                    {t.stationId} · {t.readingAt ? new Date(t.readingAt).toLocaleString('ru-RU') : 'нет данных'}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
