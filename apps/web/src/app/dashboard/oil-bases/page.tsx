'use client';
import { useEffect, useState, useCallback } from 'react';
import {
  Plus, Pencil, Trash2, Building2, Wifi, WifiOff,
  Layers, LinkIcon, Unlink, ChevronDown, ChevronRight,
  MapPin, Zap,
} from 'lucide-react';
import { oilBasesApi, stationsApi } from '@/lib/api';
import { useT } from '@/hooks/use-t';
import { useFormats } from '@/hooks/use-formats';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Modal, Confirm } from '@/components/ui/modal';
import { useWebSocket } from '@/hooks/use-websocket';
import { cn } from '@/lib/utils';

const EMPTY_FORM = { name: '', address: '' };

export default function OilBasesPage() {
  const t = useT();
  const { fmtVolume, fmtRelative } = useFormats();
  const [oilBases, setOilBases]       = useState<any[]>([]);
  const [standalone, setStandalone]   = useState<any[]>([]);
  const [allStations, setAllStations] = useState<any[]>([]);
  const [loading, setLoading]         = useState(true);
  const [expanded, setExpanded]       = useState<Record<string, boolean>>({});

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing]       = useState<any>(null);
  const [form, setForm]             = useState(EMPTY_FORM);
  const [formErr, setFormErr]       = useState('');
  const [saving, setSaving]         = useState(false);

  const [deleting, setDeleting]     = useState<any>(null);

  const [assignTarget, setAssignTarget] = useState<any>(null);
  const [assigning, setAssigning]       = useState(false);

  const { connected } = useWebSocket();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sumRes, stRes] = await Promise.all([
        oilBasesApi.summary() as Promise<any>,
        stationsApi.list()   as Promise<any>,
      ]);
      setOilBases(sumRes?.oilBases   ?? []);
      setStandalone(sumRes?.standalone ?? []);
      setAllStations(Array.isArray(stRes) ? stRes : []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggle(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  }

  function openCreate() { setForm(EMPTY_FORM); setFormErr(''); setShowCreate(true); }
  async function saveCreate() {
    if (!form.name.trim()) { setFormErr(t('nameRequired')); return; }
    setSaving(true); setFormErr('');
    try {
      await oilBasesApi.create({ name: form.name.trim(), address: form.address.trim() || undefined });
      setShowCreate(false); load();
    } catch (e: any) { setFormErr(e?.response?.data?.message ?? t('error')); }
    finally { setSaving(false); }
  }

  function openEdit(ob: any) {
    setForm({ name: ob.name, address: ob.address ?? '' });
    setFormErr(''); setEditing(ob);
  }
  async function saveEdit() {
    if (!form.name.trim()) { setFormErr(t('nameRequired')); return; }
    setSaving(true); setFormErr('');
    try {
      await oilBasesApi.update(editing.id, { name: form.name.trim(), address: form.address.trim() || undefined });
      setEditing(null); load();
    } catch (e: any) { setFormErr(e?.response?.data?.message ?? t('error')); }
    finally { setSaving(false); }
  }

  async function confirmDelete() {
    setSaving(true);
    try { await oilBasesApi.delete(deleting.id); setDeleting(null); load(); }
    finally { setSaving(false); }
  }

  async function assignStation(stationId: string) {
    if (!assignTarget) return;
    setAssigning(true);
    try {
      await oilBasesApi.assignStation(assignTarget.id, stationId);
      load();
    } finally { setAssigning(false); }
  }

  async function detachStation(oilBaseId: string, stationId: string) {
    try {
      await oilBasesApi.detachStation(oilBaseId, stationId);
      load();
    } catch {}
  }

  const isOnline = (s: any) =>
    s.lastSyncAt && (Date.now() - new Date(s.lastSyncAt).getTime()) < 10 * 60_000;

  function renderFormFields(isCreate: boolean) {
    return (
      <div className="space-y-5">
        <Input label={t('oilBaseName')} value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <Input label={t('address')} value={form.address}
          onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
        {formErr && <p className="text-sm text-red-600">{formErr}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline"
            onClick={() => isCreate ? setShowCreate(false) : setEditing(null)}>
            {t('cancel')}
          </Button>
          <Button loading={saving} onClick={isCreate ? saveCreate : saveEdit}>
            {t('save')}
          </Button>
        </div>
      </div>
    );
  }

  const totalStations = oilBases.reduce((n, ob) => n + (ob.stations?.length ?? 0), 0)
    + standalone.length;

  return (
    <div className="animate-fade-in">
      <Header
        title={t('navOilBases')}
        subtitle={loading ? undefined : `${oilBases.length} ${t('navOilBases').toLowerCase()} · ${totalStations} ${t('stations').toLowerCase()}`}
        connected={connected}
      />

      <div className="p-2 sm:p-4">
        <div className="mb-6 flex justify-end">
          <Button onClick={openCreate} size="md" className="shadow-brand-500/30 shadow-lg">
            <Plus size={18} /> {t('addOilBase')}
          </Button>
        </div>

        {loading ? (
          <div className="space-y-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="panel p-5 h-32 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            {oilBases.length === 0 && standalone.length === 0 ? (
              <div className="flex flex-col items-center py-20">
                <Building2 size={40} className="text-slate-300 mb-4" />
                <p className="text-slate-400 mb-4">{t('noOilBases')}</p>
                <Button onClick={openCreate} size="sm"><Plus size={16} /> {t('createFirst')}</Button>
              </div>
            ) : (
              <>
                {oilBases.map(ob => {
                  const open = expanded[ob.id] ?? true;
                  return (
                    <div key={ob.id} className="panel overflow-hidden">
                      <div className="flex items-center gap-3 px-5 py-4 cursor-pointer select-none"
                        onClick={() => toggle(ob.id)}>
                        <button className="text-slate-400 hover:text-slate-600 flex-shrink-0">
                          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        </button>
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 border border-brand-100 flex-shrink-0">
                          <Building2 size={18} className="text-brand-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-slate-900">{ob.name}</p>
                          {ob.address && (
                            <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                              <MapPin size={11} /> {ob.address}
                            </p>
                          )}
                        </div>

                        <div className="hidden sm:flex items-center gap-4 text-xs text-slate-500 mr-2">
                          <span className="flex items-center gap-1">
                            <Layers size={13} /> {ob.stations?.length ?? 0} {t('stationsCount')}
                          </span>
                          <span className="flex items-center gap-1">
                            <Zap size={13} /> {ob.todayTransactions} {t('txPerDay')}
                          </span>
                          <span className="font-medium text-slate-700">
                            {fmtVolume(ob.todayVolume ?? 0)}
                          </span>
                          {ob.activeShifts > 0 && (
                            <Badge variant="success">{ob.activeShifts} {t('shiftsUnit')}</Badge>
                          )}
                        </div>

                        <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                          <button
                            onClick={() => setAssignTarget(ob)}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                            title={t('assignStation')}
                          >
                            <LinkIcon size={14} />
                            <span className="hidden sm:inline">{t('station')}</span>
                          </button>
                          <button onClick={() => openEdit(ob)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors">
                            <Pencil size={14} />
                          </button>
                          <button onClick={() => setDeleting(ob)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>

                      {open && (
                        <div className="border-t border-slate-100">
                          {ob.stations?.length === 0 ? (
                            <div className="px-5 py-4 text-sm text-slate-400 flex items-center gap-2">
                              <Layers size={14} />
                              {t('noStationsInBase')} —
                              <button onClick={() => setAssignTarget(ob)}
                                className="text-brand-600 hover:underline">
                                {t('attach')}
                              </button>
                            </div>
                          ) : (
                            <div className="divide-y divide-slate-50">
                              {ob.stations.map((s: any) => (
                                <div key={s.id}
                                  className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50/60 transition-colors">
                                  <span className={cn(
                                    'h-2 w-2 rounded-full flex-shrink-0',
                                    isOnline(s) ? 'bg-emerald-400' : 'bg-slate-300',
                                  )} />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-slate-800 truncate">{s.name}</p>
                                    <p className="text-xs text-slate-400">
                                      {s.lastSyncAt ? fmtRelative(s.lastSyncAt) : t('noSync')}
                                    </p>
                                  </div>
                                  <Badge variant={isOnline(s) ? 'success' : 'neutral'} className="hidden sm:flex">
                                    {isOnline(s) ? <><Wifi size={10} /> {t('online')}</> : <><WifiOff size={10} /> {t('offline')}</>}
                                  </Badge>
                                  <button
                                    onClick={() => detachStation(ob.id, s.id)}
                                    className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                                    title={t('unassignStation')}
                                  >
                                    <Unlink size={14} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {standalone.length > 0 && (
                  <div className="panel overflow-hidden opacity-80">
                    <div className="flex items-center gap-3 px-5 py-4 cursor-pointer select-none"
                      onClick={() => toggle('__standalone__')}>
                      <button className="text-slate-400 flex-shrink-0">
                        {expanded['__standalone__'] ?? true
                          ? <ChevronDown size={18} />
                          : <ChevronRight size={18} />}
                      </button>
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 flex-shrink-0">
                        <Layers size={18} className="text-slate-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-slate-600">{t('noOilBase')}</p>
                        <p className="text-xs text-slate-400">{standalone.length} {t('stations').toLowerCase()}</p>
                      </div>
                    </div>
                    {(expanded['__standalone__'] ?? true) && (
                      <div className="border-t border-slate-100 divide-y divide-slate-50">
                        {standalone.map((s: any) => (
                          <div key={s.id}
                            className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50/60">
                            <span className={cn(
                              'h-2 w-2 rounded-full flex-shrink-0',
                              isOnline(s) ? 'bg-emerald-400' : 'bg-slate-300',
                            )} />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-slate-700 truncate">{s.name}</p>
                              <p className="text-xs text-slate-400">
                                {s.lastSyncAt ? fmtRelative(s.lastSyncAt) : t('noSync')}
                              </p>
                            </div>
                            <Badge variant={isOnline(s) ? 'success' : 'neutral'} className="hidden sm:flex">
                              {isOnline(s) ? <><Wifi size={10} /> {t('online')}</> : <><WifiOff size={10} /> {t('offline')}</>}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={t('newOilBase')}>
        {renderFormFields(true)}
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={t('editOilBase')}>
        {renderFormFields(false)}
      </Modal>

      <Confirm
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        loading={saving}
        title={t('deleteOilBase')}
        message={`${t('deleteOilBase')} "${deleting?.name}"? ${t('deleteOilBaseMsg')}`}
        confirmLabel={t('delete')}
        danger
      />

      <Modal
        open={!!assignTarget}
        onClose={() => setAssignTarget(null)}
        title={`${t('assignStation')} → ${assignTarget?.name ?? ''}`}
        size="md"
      >
        <AssignStationPicker
          oilBase={assignTarget}
          allStations={allStations}
          onAssign={assignStation}
          assigning={assigning}
        />
      </Modal>
    </div>
  );
}

function AssignStationPicker({
  oilBase, allStations, onAssign, assigning,
}: {
  oilBase: any;
  allStations: any[];
  onAssign: (stationId: string) => void;
  assigning: boolean;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const isOnline = (s: any) =>
    s.lastSyncAt && (Date.now() - new Date(s.lastSyncAt).getTime()) < 10 * 60_000;

  const candidates = allStations.filter(s =>
    s.oilBaseId !== oilBase?.id &&
    (query.trim() === '' ||
      s.name.toLowerCase().includes(query.trim().toLowerCase()) ||
      s.id.toLowerCase().includes(query.trim().toLowerCase())),
  );

  if (!oilBase) return null;

  return (
    <div className="space-y-4">
      <Input
        placeholder={t('searchByNameOrId')}
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto rounded-lg border border-slate-200">
        {candidates.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">{t('noAvailableStations')}</p>
        ) : (
          candidates.map(s => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
              <span className={cn(
                'h-2 w-2 rounded-full flex-shrink-0',
                isOnline(s) ? 'bg-emerald-400' : 'bg-slate-300',
              )} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800">{s.name}</p>
                <p className="text-xs text-slate-400">{s.id}</p>
                {s.oilBaseId && (
                  <p className="text-xs text-amber-600">{t('inOtherOilBase')}</p>
                )}
              </div>
              <Button size="sm" loading={assigning} onClick={() => onAssign(s.id)}>
                <LinkIcon size={13} /> {t('attach')}
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
