'use client';
import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, RotateCcw, Wifi, WifiOff, Copy, Check, Search, Building2, Layers, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { stationsApi, oilBasesApi } from '@/lib/api';
import { useFormats } from '@/hooks/use-formats';
import { useT } from '@/hooks/use-t';
import { useAuthStore } from '@/store/auth';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Modal, Confirm } from '@/components/ui/modal';
import { useWebSocket } from '@/hooks/use-websocket';
import { cn } from '@/lib/utils';

const EMPTY = { id: '', name: '', address: '', timezone: 'Asia/Tashkent', ipAllowlist: '' };

export default function StationsPage() {
  const t = useT();
  const { fmtRelative } = useFormats();
  const { user } = useAuthStore();
  const [stations, setStations]   = useState<any[]>([]);
  const [oilBases, setOilBases]   = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing]   = useState<any>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const [rotatingKey, setRotatingKey] = useState<any>(null);
  const [newKey, setNewKey]     = useState<string | null>(null);
  const [copied, setCopied]     = useState(false);
  const [form, setForm]         = useState(EMPTY);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [query, setQuery]       = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [stRes, sumRes]: any[] = await Promise.all([
        stationsApi.list(),
        oilBasesApi.summary(),
      ]);
      setStations(Array.isArray(stRes) ? stRes : []);
      setOilBases(sumRes?.oilBases ?? []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  const { connected } = useWebSocket();

  const isOnline = (s: any) =>
    s.lastSyncAt && (Date.now() - new Date(s.lastSyncAt).getTime()) < 10 * 60_000;

  function openCreate() { setForm(EMPTY); setError(''); setShowCreate(true); }
  function openEdit(s: any) {
    setForm({ id: s.id, name: s.name, address: s.address ?? '', timezone: s.timezone ?? 'Asia/Tashkent', ipAllowlist: (s.ipAllowlist ?? []).join(', ') });
    setError(''); setEditing(s);
  }

  async function saveCreate() {
    if (!form.id || !form.name) { setError(t('idAndNameRequired')); return; }
    setSaving(true); setError('');
    try {
      await stationsApi.create({ id: form.id, companyId: user?.companyId, name: form.name, address: form.address || undefined, timezone: form.timezone, ipAllowlist: form.ipAllowlist ? form.ipAllowlist.split(',').map((s: string) => s.trim()).filter(Boolean) : [] });
      setShowCreate(false); load();
    } catch (e: any) { setError(e?.response?.data?.message ?? t('error')); }
    finally { setSaving(false); }
  }

  async function saveEdit() {
    if (!form.name) { setError(t('nameRequired')); return; }
    setSaving(true); setError('');
    try {
      await stationsApi.update(editing.id, { name: form.name, address: form.address || undefined, timezone: form.timezone, ipAllowlist: form.ipAllowlist ? form.ipAllowlist.split(',').map((s: string) => s.trim()).filter(Boolean) : [] });
      setEditing(null); load();
    } catch (e: any) { setError(e?.response?.data?.message ?? t('error')); }
    finally { setSaving(false); }
  }

  async function confirmDelete() {
    setSaving(true);
    try { await stationsApi.delete(deleting.id); setDeleting(null); load(); }
    finally { setSaving(false); }
  }

  async function confirmRotate() {
    setSaving(true);
    try { const res: any = await stationsApi.rotateKey(rotatingKey.id); setNewKey(res.apiKey); }
    finally { setSaving(false); }
  }

  function copyKey() {
    if (!newKey) return;
    navigator.clipboard.writeText(newKey);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  }

  const visibleStations = stations.filter((s: any) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      String(s.name ?? '').toLowerCase().includes(q) ||
      String(s.id ?? '').toLowerCase().includes(q) ||
      String(s.address ?? '').toLowerCase().includes(q)
    );
  });

  function renderStationCard(s: any) {
    return (
      <div key={s.id} className={cn('panel transition-all duration-200 hover:shadow-md overflow-hidden relative group border-t-4', isOnline(s) ? 'border-t-emerald-400' : 'border-t-slate-300')}>
        <div className="p-6">
          <div className="flex items-start justify-between mb-3">
            <div className="min-w-0"><h3 className="font-semibold text-slate-900 truncate">{s.name}</h3>{s.address && <p className="text-xs text-slate-400 mt-0.5 truncate">{s.address}</p>}</div>
            <Badge variant={isOnline(s) ? 'success' : 'neutral'} className="ml-2 flex-shrink-0">{isOnline(s) ? <><Wifi size={10} /> {t('online')}</> : <><WifiOff size={10} /> {t('offline')}</>}</Badge>
          </div>
          <div className="mt-3 space-y-1 text-xs text-slate-500">
            <div className="flex justify-between"><span>ID</span><code className="bg-slate-100 rounded px-1.5 py-0.5 text-slate-600">{s.id}</code></div>
            <div className="flex justify-between"><span>{t('sync')}</span><span>{s.lastSyncAt ? fmtRelative(s.lastSyncAt) : t('noSyncShort')}</span></div>
          </div>
        </div>
        <div className="flex items-center gap-1 px-5 py-3 border-t border-slate-100 bg-slate-50">
          <Link href={`/dashboard/stations/${s.id}`} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-brand-600 hover:bg-brand-50 transition-colors"><ExternalLink size={14} /> {t('details')}</Link>
          <button onClick={() => openEdit(s)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-brand-600 hover:bg-white transition-colors"><Pencil size={14} /> {t('edit')}</button>
          <button onClick={() => { setRotatingKey(s); setNewKey(null); }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-amber-600 hover:bg-white transition-colors"><RotateCcw size={14} /> {t('apiKey')}</button>
          <button onClick={() => setDeleting(s)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-red-600 hover:bg-white transition-colors ml-auto"><Trash2 size={14} /> {t('delete')}</button>
        </div>
      </div>
    );
  }

  function renderFormFields(isCreate: boolean) {
    return (
      <div className="space-y-5">
        {isCreate && (
          <Input label={t('stationIdLabel')} value={form.id} onChange={e => setForm(f => ({ ...f, id: e.target.value }))} placeholder="ung-station-01" />
        )}
        <Input label={t('name')} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <Input label={t('address')} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="ул. Навои 5, Ташкент" />
        <div className="flex flex-col gap-1.5">
          <label className="control-label">{t('timezone')}</label>
          <select value={form.timezone} onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))} className="field-control rounded-lg py-2.5 focus:border-brand-500 focus:ring-brand-500/20">
            <option value="Asia/Tashkent">Asia/Tashkent (+5)</option>
            <option value="UTC">UTC</option>
          </select>
        </div>
        <Input label={t('ipAllowlist')} value={form.ipAllowlist} onChange={e => setForm(f => ({ ...f, ipAllowlist: e.target.value }))} placeholder="192.168.1.10, 10.0.0.5" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={() => isCreate ? setShowCreate(false) : setEditing(null)}>{t('cancel')}</Button>
          <Button loading={saving} onClick={isCreate ? saveCreate : saveEdit}>{t('save')}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <Header
        title={t('navStations')}
        subtitle={query ? `${visibleStations.length} ${t('of')} ${stations.length} ${t('stationsCount')}` : `${stations.length} ${t('stationsCount')}`}
        connected={connected}
      />
      <div className="p-2 sm:p-4">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full sm:max-w-sm">
            <Input
              placeholder={t('searchStations')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              icon={<Search size={16} />}
            />
          </div>
          <Button onClick={openCreate} size="md" className="shadow-brand-500/30 shadow-lg"><Plus size={18} /> {t('addStation')}</Button>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {Array.from({ length: 3 }).map((_, i) => <div key={i} className="panel p-5 h-44 animate-pulse" />)}
          </div>
        ) : visibleStations.length === 0 ? (
          <div className="flex flex-col items-center py-16">
            <p className="text-slate-400 mb-4">{query ? t('nothingFound') : t('noStations')}</p>
            {!query && <Button onClick={openCreate} size="sm"><Plus size={16} /> {t('addFirst')}</Button>}
          </div>
        ) : oilBases.length > 0 ? (
          <div className="space-y-6">
            {oilBases.map(ob => {
              const groupStations = visibleStations.filter((s: any) => s.oilBaseId === ob.id);
              if (groupStations.length === 0 && query) return null;
              return (
                <div key={ob.id}>
                  <div className="flex items-center gap-2 mb-3">
                    <Building2 size={15} className="text-brand-500 flex-shrink-0" />
                    <h2 className="text-sm font-semibold text-slate-700">{ob.name}</h2>
                    <span className="text-xs text-slate-400">· {groupStations.length} {t('stationsCount')}</span>
                  </div>
                  {groupStations.length === 0 ? (
                    <p className="text-xs text-slate-400 pl-5">{t('noStationsInBase')}</p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {groupStations.map((s: any) => renderStationCard(s))}
                    </div>
                  )}
                </div>
              );
            })}
            {(() => {
              const obIds = new Set(oilBases.map((ob: any) => ob.id));
              const standalone = visibleStations.filter((s: any) => !s.oilBaseId || !obIds.has(s.oilBaseId));
              if (standalone.length === 0) return null;
              return (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Layers size={15} className="text-slate-400 flex-shrink-0" />
                    <h2 className="text-sm font-semibold text-slate-500">{t('noOilBase')}</h2>
                    <span className="text-xs text-slate-400">· {standalone.length} {t('stationsCount')}</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {standalone.map((s: any) => renderStationCard(s))}
                  </div>
                </div>
              );
            })()}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {visibleStations.map((s: any) => renderStationCard(s))}
          </div>
        )}
      </div>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={t('newStation')}>{renderFormFields(true)}</Modal>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={t('editStation')}>{renderFormFields(false)}</Modal>

      <Modal open={!!rotatingKey} onClose={() => { setRotatingKey(null); setNewKey(null); }} title={t('rotateApiKey')} size="sm">
        {newKey ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">{t('newKeyFor')} <b>{rotatingKey?.name}</b>. {t('newKeySave')}</p>
            <div className="flex items-center gap-2 bg-slate-900 rounded-lg px-3 py-2.5">
              <code className="flex-1 text-xs text-emerald-400 break-all">{newKey}</code>
              <button onClick={copyKey} className="text-slate-400 hover:text-white flex-shrink-0">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
            </div>
            <Button className="w-full" onClick={() => { setRotatingKey(null); setNewKey(null); load(); }}>{t('done')}</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">{t('revokeKeyFor')} <b>{rotatingKey?.name}</b> {t('revokeKeyAction')}</p>
            <div className="flex gap-3 justify-end"><Button variant="outline" onClick={() => setRotatingKey(null)}>{t('cancel')}</Button><Button loading={saving} onClick={confirmRotate}>{t('updateKey')}</Button></div>
          </div>
        )}
      </Modal>

      <Confirm
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        loading={saving}
        title={t('deleteStation')}
        message={`${t('deleteStation')} "${deleting?.name}"?`}
        confirmLabel={t('delete')}
        danger
      />
    </div>
  );
}
