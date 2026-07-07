'use client';
import { useEffect, useState, useCallback } from 'react';
import { Droplets, RefreshCw, AlertTriangle, Plus, Pencil } from 'lucide-react';
import { reservoirsApi, stationsApi } from '@/lib/api';
import { useT } from '@/hooks/use-t';
import { Header } from '@/components/layout/header';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils';

type TankForm = {
  stationId: string;
  tankId: string;
  label: string;
  productId: number;
  productName: string;
  capacity: number;
};

const EMPTY_FORM: TankForm = { stationId: '', tankId: '', label: '', productId: 0, productName: '', capacity: 0 };

function TankGauge({ percent, levelLabel }: { percent: number | null; levelLabel: string }) {
  const pct = Math.max(0, Math.min(100, percent ?? 0));
  const color = pct < 15 ? 'bg-red-500' : pct < 30 ? 'bg-amber-400' : 'bg-emerald-400';
  return (
    <div className="mt-3">
      <div className="flex justify-between text-xs text-slate-500 mb-1">
        <span>{levelLabel}</span>
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
  const t = useT();
  const role = useAuthStore(s => s.user?.role);
  const canManage = role === 'SUPER_ADMIN' || role === 'COMPANY_ADMIN' || role === 'STATION_MANAGER';

  const [tanks, setTanks]     = useState<any[]>([]);
  const [stations, setStations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [isEdit, setIsEdit]     = useState(false);
  const [form, setForm]         = useState<TankForm>({ ...EMPTY_FORM });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await reservoirsApi.latest();
      setTanks(Array.isArray(res) ? res : []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!canManage) return;
    stationsApi.list().then((s: any) => setStations(Array.isArray(s) ? s : [])).catch(() => {});
  }, [canManage]);

  const { connected } = useWebSocket(useCallback((ev: string) => {
    if (ev === 'tank.updated') load();
  }, [load]));

  function openCreate() {
    setForm({ ...EMPTY_FORM, stationId: stations[0]?.id ?? '' });
    setIsEdit(false); setError(''); setShowForm(true);
  }
  function openEdit(tank: any) {
    setForm({
      stationId: tank.stationId,
      tankId: tank.tankId,
      label: tank.label ?? '',
      productId: tank.productId ?? 0,
      productName: tank.productName ?? '',
      capacity: tank.capacity ?? 0,
    });
    setIsEdit(true); setError(''); setShowForm(true);
  }

  async function save() {
    if (!form.stationId || !form.tankId.trim()) { setError(t('error')); return; }
    setSaving(true); setError('');
    try {
      await reservoirsApi.create({
        stationId: form.stationId,
        tankId: form.tankId.trim(),
        label: form.label.trim() || `Tank ${form.tankId.trim()}`,
        productId: Number(form.productId) || 0,
        productName: form.productName.trim(),
        capacity: Number(form.capacity) || 0,
      });
      setShowForm(false);
      load();
    } catch (e: any) { setError(e?.response?.data?.message ?? t('error')); }
    finally { setSaving(false); }
  }

  return (
    <div className="animate-fade-in">
      <Header title={t('navTanks')} subtitle={`${tanks.length} ${t('tanksPage').toLowerCase()}`} connected={connected} />

      <div className="p-6">
        <div className="flex justify-end items-center gap-4 mb-4">
          <button onClick={load} disabled={loading} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 transition-colors">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {t('reset')}
          </button>
          {canManage && (
            <Button size="sm" onClick={openCreate}><Plus size={16} /> {t('addTank')}</Button>
          )}
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="bg-white rounded-xl shadow-card p-5 h-40 animate-pulse" />)}
          </div>
        ) : tanks.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-slate-400 gap-3">
            <Droplets size={40} className="opacity-30" />
            <p>{t('noTankData')}</p>
            {canManage && <Button onClick={openCreate}><Plus size={16} /> {t('addTank')}</Button>}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {tanks.map((tank: any) => {
              const pct = tank.fillPercent;
              const isLow = pct != null && pct < 20;
              return (
                <div key={tank.id} className={cn('bg-white rounded-xl shadow-card p-5 border-l-4', isLow ? 'border-l-red-400' : 'border-l-slate-200')}>
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold text-slate-900">{tank.label}</h3>
                      <p className="text-xs text-slate-400 mt-0.5">{tank.productName || '—'}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      {canManage && (
                        <button onClick={() => openEdit(tank)} title={t('editTank')}
                          className="p-2 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors">
                          <Pencil size={14} />
                        </button>
                      )}
                      <div className={cn('p-2 rounded-lg', isLow ? 'bg-red-50 text-red-500' : 'bg-blue-50 text-blue-500')}>
                        {isLow ? <AlertTriangle size={16} /> : <Droplets size={16} />}
                      </div>
                    </div>
                  </div>

                  <TankGauge percent={pct} levelLabel={t('tankLevel')} />

                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-slate-50 rounded-lg p-2">
                      <p className="text-slate-400">{t('volume')}</p>
                      <p className="font-semibold text-slate-800 mt-0.5">
                        {tank.volumeLitres != null ? `${tank.volumeLitres.toFixed(0)} л` : '—'}
                      </p>
                    </div>
                    <div className="bg-slate-50 rounded-lg p-2">
                      <p className="text-slate-400">{t('capacity')}</p>
                      <p className="font-semibold text-slate-800 mt-0.5">
                        {tank.capacity ? `${tank.capacity.toFixed(0)} л` : '—'}
                      </p>
                    </div>
                    {tank.temperatureC != null && (
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-400">T°C</p>
                        <p className="font-semibold text-slate-800 mt-0.5">{tank.temperatureC.toFixed(1)}°C</p>
                      </div>
                    )}
                    {tank.levelMm != null && (
                      <div className="bg-slate-50 rounded-lg p-2">
                        <p className="text-slate-400">{t('tankLevel')}</p>
                        <p className="font-semibold text-slate-800 mt-0.5">{tank.levelMm.toFixed(0)} mm</p>
                      </div>
                    )}
                  </div>

                  <p className="text-xs text-slate-400 mt-2">
                    {tank.stationId} · {tank.readingAt ? new Date(tank.readingAt).toLocaleString('ru-RU') : t('noData')}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)} title={isEdit ? t('editTank') : t('addTank')}>
        <div className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <label className="control-label">{t('station')}</label>
            <select
              value={form.stationId}
              disabled={isEdit}
              onChange={e => setForm(f => ({ ...f, stationId: e.target.value }))}
              className="field-control rounded-lg py-2.5 disabled:opacity-60"
            >
              <option value="" disabled>—</option>
              {stations.map((s: any) => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)}
            </select>
          </div>

          <Input label={t('tankId')} value={form.tankId} disabled={isEdit}
            onChange={e => setForm(f => ({ ...f, tankId: e.target.value }))} placeholder="tank1" />
          <Input label={t('name')} value={form.label}
            onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="Tank 1 - AI-92" />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="control-label">{t('productCode')}</label>
              <input type="number" value={form.productId}
                onChange={e => setForm(f => ({ ...f, productId: Number(e.target.value) }))}
                className="field-control mt-1.5 w-full rounded-lg py-2" />
            </div>
            <Input label={t('product')} value={form.productName}
              onChange={e => setForm(f => ({ ...f, productName: e.target.value }))} placeholder="AI-92" />
          </div>

          <div>
            <label className="control-label">{t('capacity')} (л)</label>
            <input type="number" min={0} value={form.capacity}
              onChange={e => setForm(f => ({ ...f, capacity: Number(e.target.value) }))}
              className="field-control mt-1.5 w-full rounded-lg py-2" />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => setShowForm(false)}>{t('cancel')}</Button>
            <Button loading={saving} onClick={save}>{t('save')}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
