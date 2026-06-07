'use client';
import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Bell, BellOff } from 'lucide-react';
import { alertRulesApi } from '@/lib/api';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Modal, Confirm } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';

const TYPES = [
  { value: 'tank_low',           label: 'Низкий уровень топлива',    unit: '%' },
  { value: 'sync_lag',           label: 'Задержка синхронизации',     unit: 'мин' },
  { value: 'station_offline',    label: 'Станция оффлайн',            unit: 'мин' },
  { value: 'dispenser_offline',  label: 'Колонка оффлайн',            unit: 'мин' },
];

const EMPTY_FORM = { type: 'tank_low', threshold: 20, stationId: '', notifyTelegram: true, notifyEmail: false };

export default function AlertsPage() {
  const toast = useToast();
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
      toast.success('Правило создано');
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Ошибка создания');
    } finally { setSaving(false); }
  }

  async function toggleEnabled(rule: any) {
    setToggling(rule.id);
    try {
      await alertRulesApi.update(rule.id, { enabled: !rule.enabled });
      load();
    } catch { toast.error('Не удалось обновить'); }
    finally { setToggling(null); }
  }

  async function confirmDelete() {
    setSaving(true);
    try {
      await alertRulesApi.delete(deleting.id);
      setDeleting(null);
      load();
      toast.success('Правило удалено');
    } finally { setSaving(false); }
  }

  const typeInfo = (type: string) => TYPES.find(t => t.value === type);

  return (
    <div className="animate-fade-in">
      <Header title="Оповещения" subtitle={`${rules.length} правил`} />

      <div className="p-6">
        <div className="flex items-start justify-between mb-6">
          <p className="text-sm text-slate-500 max-w-lg">
            Правила автоматически проверяются каждые 10 минут. Уведомления отправляются в Telegram и/или на email.
          </p>
          <Button onClick={() => { setForm(EMPTY_FORM); setShowCreate(true); }} size="sm">
            <Plus size={16} /> Добавить правило
          </Button>
        </div>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-16 bg-white rounded-xl animate-pulse" />)}
          </div>
        ) : rules.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-slate-400">
            <Bell size={40} className="mb-3 opacity-30" />
            <p>Правил оповещений нет</p>
            <Button onClick={() => setShowCreate(true)} size="sm" className="mt-4">
              <Plus size={16} /> Добавить первое правило
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
                      {!r.stationId && <Badge variant="neutral">Все станции</Badge>}
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

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Новое правило оповещения">
        <div className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Тип события</label>
            <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
              className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none">
              {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">
              Порог ({typeInfo(form.type)?.unit})
            </label>
            <input type="number" value={form.threshold}
              onChange={e => setForm(f => ({ ...f, threshold: Number(e.target.value) }))}
              className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Станция (пусто = все)</label>
            <input type="text" value={form.stationId} placeholder="ID станции"
              onChange={e => setForm(f => ({ ...f, stationId: e.target.value }))}
              className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20" />
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={form.notifyTelegram}
                onChange={e => setForm(f => ({ ...f, notifyTelegram: e.target.checked }))}
                className="rounded" />
              Telegram
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={form.notifyEmail}
                onChange={e => setForm(f => ({ ...f, notifyEmail: e.target.checked }))}
                className="rounded" />
              Email
            </label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setShowCreate(false)}>Отмена</Button>
            <Button loading={saving} onClick={saveCreate}>Создать</Button>
          </div>
        </div>
      </Modal>

      <Confirm open={!!deleting} onClose={() => setDeleting(null)} onConfirm={confirmDelete}
        loading={saving} title="Удалить правило"
        message={`Удалить правило "${typeInfo(deleting?.type)?.label}"?`} confirmLabel="Удалить" danger />
    </div>
  );
}
