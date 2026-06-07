'use client';
import { useEffect, useState, useCallback } from 'react';
import {
  Plus, Pencil, Trash2, Zap, CheckCircle, XCircle, Clock,
  ChevronDown, ChevronUp, RefreshCw, Eye, EyeOff,
} from 'lucide-react';
import { integrationsApi } from '@/lib/api';
import { fmtDate, fmtRelative } from '@/lib/format';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Modal, Confirm } from '@/components/ui/modal';
import { useWebSocket } from '@/hooks/use-websocket';
import { cn } from '@/lib/utils';

const ALL_EVENTS = [
  { id: 'transaction.completed', label: 'Транзакции',  desc: 'Каждая завершённая транзакция' },
  { id: 'shift.closed',          label: 'Смены',       desc: 'Закрытие смены с итогами' },
  { id: 'price.changed',         label: 'Цены',        desc: 'Изменение цены на форсунке' },
  { id: 'health.event',          label: 'Оборудование',desc: 'Онлайн/оффлайн событие диспенсера' },
  { id: 'tank.reading',          label: 'Резервуары',  desc: 'Новое показание уровня топлива' },
];

const AUTH_TYPES = [
  { value: 'none',   label: 'Нет' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'hmac',   label: 'HMAC-SHA256' },
];

const EMPTY_FORM = {
  name: '', url: '', authType: 'none', authSecret: '',
  events: [] as string[], retryLimit: 3, timeoutMs: 5000, active: true,
};

function StatusChip({ status }: { status: string }) {
  if (status === 'delivered') return <Badge variant="success"><CheckCircle size={10} /> Доставлено</Badge>;
  if (status === 'failed')    return <Badge variant="danger"><XCircle size={10} /> Ошибка</Badge>;
  return <Badge variant="neutral"><Clock size={10} /> Ожидание</Badge>;
}

function EventChip({ event }: { event: string }) {
  const e = ALL_EVENTS.find(x => x.id === event);
  return (
    <span className="inline-flex items-center rounded-md bg-brand-50 border border-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">
      {e?.label ?? event}
    </span>
  );
}

export default function IntegrationsPage() {
  const { connected } = useWebSocket();
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing]   = useState<any>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const [testing, setTesting]   = useState<string | null>(null);
  const [form, setForm]         = useState({ ...EMPTY_FORM });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [showSecret, setShowSecret] = useState(false);

  // Delivery log drawer state
  const [openDeliveries, setOpenDeliveries] = useState<string | null>(null);
  const [deliveries, setDeliveries]         = useState<any[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await integrationsApi.list();
      setIntegrations(Array.isArray(res) ? res : []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreate() { setForm({ ...EMPTY_FORM }); setError(''); setShowSecret(false); setShowCreate(true); }
  function openEdit(i: any) {
    setForm({
      name: i.name, url: i.url, authType: i.authType,
      authSecret: i.authSecret ?? '', events: [...i.events],
      retryLimit: i.retryLimit, timeoutMs: i.timeoutMs, active: i.active,
    });
    setError(''); setShowSecret(false); setEditing(i);
  }

  function toggleEvent(id: string) {
    setForm(f => ({
      ...f,
      events: f.events.includes(id) ? f.events.filter(e => e !== id) : [...f.events, id],
    }));
  }

  async function save(isCreate: boolean) {
    if (!form.name || !form.url) { setError('Название и URL обязательны'); return; }
    if (form.events.length === 0) { setError('Выберите хотя бы одно событие'); return; }
    setSaving(true); setError('');
    const payload = {
      name: form.name, url: form.url,
      authType: form.authType,
      authSecret: form.authSecret || undefined,
      events: form.events, retryLimit: form.retryLimit,
      timeoutMs: form.timeoutMs, active: form.active,
    };
    try {
      if (isCreate) {
        await integrationsApi.create(payload);
        setShowCreate(false);
      } else {
        await integrationsApi.update(editing.id, payload);
        setEditing(null);
      }
      load();
    } catch (e: any) { setError(e?.response?.data?.message ?? 'Ошибка'); }
    finally { setSaving(false); }
  }

  async function confirmDelete() {
    setSaving(true);
    try { await integrationsApi.remove(deleting.id); setDeleting(null); load(); }
    finally { setSaving(false); }
  }

  async function sendTest(id: string) {
    setTesting(id);
    try {
      const res: any = await integrationsApi.test(id);
      alert(res?.status === 'delivered'
        ? `✓ Тест доставлен (HTTP ${res.responseStatus})`
        : `✗ Ошибка: ${res?.error ?? 'unknown'}`);
    } catch { alert('Ошибка теста'); }
    finally { setTesting(null); }
  }

  async function loadDeliveries(id: string) {
    if (openDeliveries === id) { setOpenDeliveries(null); return; }
    setOpenDeliveries(id);
    setDeliveries([]);
    setDeliveriesLoading(true);
    try {
      const res: any = await integrationsApi.deliveries(id);
      setDeliveries(Array.isArray(res) ? res : []);
    } finally { setDeliveriesLoading(false); }
  }

  function renderForm(isCreate: boolean) {
    return (
      <div className="space-y-5">
        <Input label="Название" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="ERP система" />
        <Input label="URL" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://erp.company.com/webhooks/fuel" />

        {/* Auth */}
        <div className="flex flex-col gap-1.5">
          <label className="control-label">Аутентификация</label>
          <select
            value={form.authType}
            onChange={e => setForm(f => ({ ...f, authType: e.target.value }))}
            className="field-control rounded-lg py-2.5"
          >
            {AUTH_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </div>
        {form.authType !== 'none' && (
          <div className="relative">
            <Input
              label={form.authType === 'bearer' ? 'Bearer Token' : 'HMAC Secret'}
              value={form.authSecret}
              type={showSecret ? 'text' : 'password'}
              onChange={e => setForm(f => ({ ...f, authSecret: e.target.value }))}
              placeholder={form.authType === 'bearer' ? 'eyJ...' : 'секрет для подписи'}
            />
            <button
              type="button"
              onClick={() => setShowSecret(s => !s)}
              className="absolute right-3 top-9 text-slate-400 hover:text-slate-700"
            >
              {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        )}

        {/* Events */}
        <div>
          <p className="control-label mb-2">События для отправки</p>
          <div className="space-y-2">
            {ALL_EVENTS.map(ev => (
              <label key={ev.id} className="flex items-start gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={form.events.includes(ev.id)}
                  onChange={() => toggleEvent(ev.id)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                <div>
                  <span className="text-sm font-medium text-slate-800 group-hover:text-brand-600 transition-colors">
                    {ev.label}
                  </span>
                  <p className="text-xs text-slate-400">{ev.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Advanced */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="control-label">Попытки (0–10)</label>
            <input
              type="number" min={0} max={10} value={form.retryLimit}
              onChange={e => setForm(f => ({ ...f, retryLimit: Number(e.target.value) }))}
              className="field-control mt-1.5 w-full rounded-lg py-2"
            />
          </div>
          <div>
            <label className="control-label">Таймаут (мс)</label>
            <input
              type="number" min={1000} max={30000} step={500} value={form.timeoutMs}
              onChange={e => setForm(f => ({ ...f, timeoutMs: Number(e.target.value) }))}
              className="field-control mt-1.5 w-full rounded-lg py-2"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox" checked={form.active}
            onChange={e => setForm(f => ({ ...f, active: e.target.checked }))}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm text-slate-700">Активна</span>
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={() => isCreate ? setShowCreate(false) : setEditing(null)}>Отмена</Button>
          <Button loading={saving} onClick={() => save(isCreate)}>Сохранить</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <Header
        title="Интеграции"
        subtitle="Вебхуки для передачи данных во внешние системы"
        connected={connected}
      />

      <div className="p-2 sm:p-4">
        <div className="mb-6 flex justify-end">
          <Button onClick={openCreate}><Plus size={16} /> Добавить интеграцию</Button>
        </div>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="panel p-5 h-32 animate-pulse" />
            ))}
          </div>
        ) : integrations.length === 0 ? (
          <div className="flex flex-col items-center py-20 gap-4">
            <div className="h-16 w-16 rounded-2xl bg-slate-100 flex items-center justify-center">
              <Zap size={28} className="text-slate-400" />
            </div>
            <p className="text-slate-400 text-center max-w-sm">
              Интеграций пока нет. Добавьте вебхук чтобы передавать данные о транзакциях, сменах и ценах во внешние системы.
            </p>
            <Button onClick={openCreate}><Plus size={16} /> Добавить первую</Button>
          </div>
        ) : (
          <div className="space-y-4">
            {integrations.map((i: any) => (
              <div key={i.id} className="panel overflow-hidden">
                {/* Header row */}
                <div className="flex items-start gap-4 p-5">
                  <div className={cn(
                    'h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0',
                    i.active ? 'bg-brand-50 text-brand-600' : 'bg-slate-100 text-slate-400',
                  )}>
                    <Zap size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-slate-900">{i.name}</h3>
                      <Badge variant={i.active ? 'success' : 'neutral'}>
                        {i.active ? 'Активна' : 'Выключена'}
                      </Badge>
                      <span className="text-xs text-slate-400 capitalize">{
                        AUTH_TYPES.find(a => a.value === i.authType)?.label ?? i.authType
                      }</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 truncate font-mono">{i.url}</p>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {i.events.map((ev: string) => <EventChip key={ev} event={ev} />)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => sendTest(i.id)}
                      disabled={testing === i.id}
                      title="Отправить тест"
                      className="p-2 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                    >
                      <RefreshCw size={14} className={testing === i.id ? 'animate-spin' : ''} />
                    </button>
                    <button
                      onClick={() => openEdit(i)}
                      className="p-2 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => setDeleting(i)}
                      className="p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Footer — delivery log toggle */}
                <div className="border-t border-slate-100 bg-slate-50 px-5 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-slate-400">
                    Попытки: {i.retryLimit} · Таймаут: {i.timeoutMs / 1000}с
                  </span>
                  <button
                    onClick={() => loadDeliveries(i.id)}
                    className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-brand-600 transition-colors"
                  >
                    {openDeliveries === i.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    Лог доставок
                  </button>
                </div>

                {/* Delivery log drawer */}
                {openDeliveries === i.id && (
                  <div className="border-t border-slate-100">
                    {deliveriesLoading ? (
                      <div className="p-4 text-center text-sm text-slate-400">Загрузка...</div>
                    ) : deliveries.length === 0 ? (
                      <div className="p-4 text-center text-sm text-slate-400">Нет доставок</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="table-head-row">
                              <th className="table-head-cell">Событие</th>
                              <th className="table-head-cell">Статус</th>
                              <th className="table-head-cell">HTTP</th>
                              <th className="table-head-cell">Попыток</th>
                              <th className="table-head-cell">Ошибка</th>
                              <th className="table-head-cell">Создан</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {deliveries.map((d: any) => (
                              <tr key={d.id} className="table-row-hover">
                                <td className="table-cell font-mono text-slate-600">{d.eventType}</td>
                                <td className="table-cell"><StatusChip status={d.status} /></td>
                                <td className="table-cell text-slate-500">{d.responseStatus ?? '—'}</td>
                                <td className="table-cell text-slate-500">{d.attempts}</td>
                                <td className="table-cell text-red-500 max-w-[200px] truncate">{d.error ?? '—'}</td>
                                <td className="table-cell text-slate-400 whitespace-nowrap">{fmtRelative(d.createdAt)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Новая интеграция">
        {renderForm(true)}
      </Modal>
      <Modal open={!!editing} onClose={() => setEditing(null)} title="Редактировать интеграцию">
        {renderForm(false)}
      </Modal>
      <Confirm
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        loading={saving}
        title="Удалить интеграцию"
        message={`Удалить "${deleting?.name}"? Все записи о доставках также будут удалены.`}
        confirmLabel="Удалить"
        danger
      />
    </div>
  );
}
