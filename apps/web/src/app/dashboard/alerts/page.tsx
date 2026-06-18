'use client';
import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Bell, BellOff } from 'lucide-react';
import { alertRulesApi } from '@/lib/api';
import { useT } from '@/hooks/use-t';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Modal, Confirm } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';

const EMPTY_FORM = { type: 'tank_low', threshold: 20, stationId: '', notifyTelegram: true, notifyEmail: false };

export default function AlertsPage() {
  const t = useT();
  const toast = useToast();

  const TYPES = [
    { value: 'tank_low',          label: t('tankLow'),          unit: '%' },
    { value: 'sync_lag',          label: t('syncLag'),           unit: 'min' },
    { value: 'station_offline',   label: t('stationOffline'),    unit: 'min' },
    { value: 'dispenser_offline', label: t('dispenserOffline'),  unit: 'min' },
  ];

  const [rules, setRules]     = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [deleting, setDeleting]     = useState<any>(null);
  const [form, setForm]       = useState(EMPTY_FORM);
  const [saving, setSaving]   = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await alertRulesApi.list();
      setRules(Array.isArray(res) ? res : []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function saveCreate() {
    setSaving(true);
    try {
      await alertRulesApi.create({
        type:           form.type,
        threshold:      form.threshold || undefined,
        stationId:      form.stationId || undefined,
        notifyTelegram: form.notifyTelegram,
        notifyEmail:    form.notifyEmail,
      });
      setShowCreate(false);
      load();
      toast.success(t('done'));
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? t('error'));
    } finally { setSaving(false); }
  }

  async function toggleEnabled(rule: any) {
    setToggling(rule.id);
    try {
      await alertRulesApi.update(rule.id, { enabled: !rule.enabled });
      load();
    } catch { toast.error(t('error')); }
    finally { setToggling(null); }
  }

  async function confirmDelete() {
    setSaving(true);
    try {
      await alertRulesApi.delete(deleting.id);
      setDeleting(null);
      load();
      toast.success(t('done'));
    } finally { setSaving(false); }
  }

  const typeInfo = (type: string) => TYPES.find(tp => tp.value === type);

  return (
    <div className="animate-fade-in">
      <Header title={t('navAlerts')} subtitle={`${rules.length} ${t('alertRules').toLowerCase()}`} />

      <div className="p-6">
        <div className="flex items-start justify-between mb-6">
          <p className="text-sm text-slate-500 max-w-lg"></p>
          <Button onClick={() => { setForm(EMPTY_FORM); setShowCreate(true); }} size="sm">
            <Plus size={16} /> {t('addRule')}
          </Button>
        </div>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-16 bg-white rounded-xl animate-pulse" />)}
          </div>
        ) : rules.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-slate-400">
            <Bell size={40} className="mb-3 opacity-30" />
            <p>{t('noAlerts')}</p>
            <Button onClick={() => setShowCreate(true)} size="sm" className="mt-4">
              <Plus size={16} /> {t('addRule')}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {rules.map((r: any) => {
              const info = typeInfo(r.type);
              return (
                <div key={r.id} className={`bg-white rounded-xl shadow-card px-5 py-4 flex items-center gap-4 ${!r.enabled ? 'opacity-60' : ''}`}>
                  <div className={`p-2 rounded-lg flex-shrink-0 ${r.enabled ? 'bg-brand-50 text-brand-600' : 'bg-slate-100 text-slate-400'}`}>
                    {r.enabled ? <Bell size={18} /> : <BellOff size={18} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-slate-900">{info?.label ?? r.type}</span>
                      {r.threshold != null && (
                        <Badge variant="info">&lt; {r.threshold}{info?.unit}</Badge>
                      )}
                      {r.stationId && <Badge variant="neutral">{r.stationId}</Badge>}
                      {!r.stationId && <Badge variant="neutral">{t('allStationsOption')}</Badge>}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
                      {r.notifyTelegram && <span>Telegram</span>}
                      {r.notifyEmail && <span>Email</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => toggleEnabled(r)}
                      disabled={toggling === r.id}
                      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${r.enabled ? 'bg-brand-600' : 'bg-slate-200'}`}
                    >
                      <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${r.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                    <button
                      onClick={() => setDeleting(r)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={t('newRule')}>
        <div className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">{t('alertType')}</label>
            <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
              className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none">
              {TYPES.map(tp => <option key={tp.value} value={tp.value}>{tp.label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">
              {t('alertThreshold')} ({typeInfo(form.type)?.unit})
            </label>
            <input type="number" value={form.threshold}
              onChange={e => setForm(f => ({ ...f, threshold: Number(e.target.value) }))}
              className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">{t('alertStation')}</label>
            <input type="text" value={form.stationId} placeholder={t('allStationsOption')}
              onChange={e => setForm(f => ({ ...f, stationId: e.target.value }))}
              className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20" />
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={form.notifyTelegram}
                onChange={e => setForm(f => ({ ...f, notifyTelegram: e.target.checked }))}
                className="rounded" />
              {t('alertTelegram')}
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={form.notifyEmail}
                onChange={e => setForm(f => ({ ...f, notifyEmail: e.target.checked }))}
                className="rounded" />
              {t('alertEmail')}
            </label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setShowCreate(false)}>{t('cancel')}</Button>
            <Button loading={saving} onClick={saveCreate}>{t('confirm')}</Button>
          </div>
        </div>
      </Modal>

      <Confirm open={!!deleting} onClose={() => setDeleting(null)} onConfirm={confirmDelete}
        loading={saving} title={t('deleteRule')}
        message={`${t('deleteRule')} "${typeInfo(deleting?.type)?.label}"?`} confirmLabel={t('delete')} danger />
    </div>
  );
}
