'use client';
import { useEffect, useState, useCallback } from 'react';
import {
  Plus, KeyRound, Pencil, Trash2, Power, Copy, Check, Gauge,
} from 'lucide-react';
import { apiTokensApi, stationsApi, oilBasesApi } from '@/lib/api';
import { useT } from '@/hooks/use-t';
import { useFormats } from '@/hooks/use-formats';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Modal, Confirm } from '@/components/ui/modal';
import { cn } from '@/lib/utils';

type TokenForm = {
  name: string;
  scopes: string[];
  rateLimitPerMin: number;
  stationIds: string[];
  oilBaseIds: string[];
  ipAllowlist: string;
  expiresAt: string;
};

const EMPTY_FORM: TokenForm = {
  name: '', scopes: [], rateLimitPerMin: 120,
  stationIds: [], oilBaseIds: [], ipAllowlist: '', expiresAt: '',
};

export function ApiTokensTab() {
  const t = useT();
  const { fmtRelative } = useFormats();

  const SCOPES = [
    { id: 'read:transactions',  label: t('transactions') },
    { id: 'read:shifts',        label: t('shifts') },
    { id: 'read:prices',        label: t('navPrices') },
    { id: 'read:stations',      label: t('navStations') },
    { id: 'read:tank_readings', label: t('navTanks') },
  ];

  const [tokens, setTokens]     = useState<any[]>([]);
  const [stations, setStations] = useState<any[]>([]);
  const [oilBases, setOilBases] = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing]   = useState<any>(null);
  const [revoking, setRevoking] = useState<any>(null);
  const [form, setForm]         = useState<TokenForm>({ ...EMPTY_FORM });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const [created, setCreated]   = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tk, st, ob] = await Promise.all([
        apiTokensApi.list(),
        stationsApi.list().catch(() => []),
        oilBasesApi.list().catch(() => []),
      ]);
      setTokens(Array.isArray(tk) ? tk : []);
      setStations(Array.isArray(st) ? st : []);
      setOilBases(Array.isArray(ob) ? ob : []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreate() { setForm({ ...EMPTY_FORM }); setError(''); setShowCreate(true); }
  function openEdit(tk: any) {
    setForm({
      name: tk.name,
      scopes: [...(tk.scopes ?? [])],
      rateLimitPerMin: tk.rateLimitPerMin ?? 120,
      stationIds: [...(tk.stationIds ?? [])],
      oilBaseIds: [...(tk.oilBaseIds ?? [])],
      ipAllowlist: (tk.ipAllowlist ?? []).join(', '),
      expiresAt: tk.expiresAt ? String(tk.expiresAt).slice(0, 10) : '',
    });
    setError(''); setEditing(tk);
  }

  function toggleIn(list: string[], id: string) {
    return list.includes(id) ? list.filter(x => x !== id) : [...list, id];
  }

  async function save(isCreate: boolean) {
    if (!form.name.trim()) { setError(t('nameAndUrlRequired')); return; }
    if (form.scopes.length === 0) { setError(t('tokScopesRequired')); return; }
    setSaving(true); setError('');
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      scopes: form.scopes,
      rateLimitPerMin: form.rateLimitPerMin,
      stationIds: form.stationIds,
      oilBaseIds: form.oilBaseIds,
      ipAllowlist: form.ipAllowlist.split(',').map(s => s.trim()).filter(Boolean),
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : undefined,
    };
    try {
      if (isCreate) {
        const res: any = await apiTokensApi.create(payload);
        setShowCreate(false);
        if (res?.token) { setCreated({ name: res.name, token: res.token }); setCopied(false); }
      } else {
        await apiTokensApi.update(editing.id, payload);
        setEditing(null);
      }
      load();
    } catch (e: any) { setError(e?.response?.data?.message ?? t('error')); }
    finally { setSaving(false); }
  }

  async function toggleActive(tk: any) {
    try { await apiTokensApi.update(tk.id, { active: !tk.active }); load(); }
    catch { /* surfaced on reload */ }
  }

  async function confirmRevoke() {
    setSaving(true);
    try { await apiTokensApi.revoke(revoking.id); setRevoking(null); load(); }
    finally { setSaving(false); }
  }

  async function copyToken() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.token); setCopied(true); }
    catch { /* clipboard may be blocked; user can select manually */ }
  }

  function statusBadge(tk: any) {
    if (tk.revokedAt) return <Badge variant="danger">{t('tokRevoked')}</Badge>;
    return <Badge variant={tk.active ? 'success' : 'neutral'}>{tk.active ? t('active') : t('inactive')}</Badge>;
  }

  function renderForm(isCreate: boolean) {
    return (
      <div className="space-y-5">
        <Input label={t('name')} value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Acme BI export" />

        <div>
          <p className="control-label mb-2">{t('tokScopes')}</p>
          <div className="space-y-2">
            {SCOPES.map(s => (
              <label key={s.id} className="flex items-center gap-3 cursor-pointer group">
                <input type="checkbox" checked={form.scopes.includes(s.id)}
                  onChange={() => setForm(f => ({ ...f, scopes: toggleIn(f.scopes, s.id) }))}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
                <span className="text-sm font-medium text-slate-800 group-hover:text-brand-600 transition-colors">{s.label}</span>
                <span className="text-xs text-slate-400 font-mono">{s.id}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="control-label">{t('tokRateLimit')}</label>
          <input type="number" min={1} max={100000} value={form.rateLimitPerMin}
            onChange={e => setForm(f => ({ ...f, rateLimitPerMin: Number(e.target.value) }))}
            className="field-control mt-1.5 w-full rounded-lg py-2" />
        </div>

        <div>
          <p className="control-label mb-2">{t('tokRestrictOilBases')}</p>
          {oilBases.length === 0 ? (
            <p className="text-xs text-slate-400">{t('tokAllOilBases')}</p>
          ) : (
            <div className="max-h-28 overflow-y-auto rounded-lg border border-slate-200 p-2 space-y-1.5">
              {oilBases.map((o: any) => (
                <label key={o.id} className="flex items-center gap-2 cursor-pointer text-sm">
                  <input type="checkbox" checked={form.oilBaseIds.includes(o.id)}
                    onChange={() => setForm(f => ({ ...f, oilBaseIds: toggleIn(f.oilBaseIds, o.id) }))}
                    className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
                  <span className="text-slate-700">{o.name}</span>
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-400 mt-1">{form.oilBaseIds.length === 0 ? t('tokAllOilBases') : ''}</p>
        </div>

        <div>
          <p className="control-label mb-2">{t('tokRestrictStations')}</p>
          {stations.length === 0 ? (
            <p className="text-xs text-slate-400">{t('tokAllStations')}</p>
          ) : (
            <div className="max-h-28 overflow-y-auto rounded-lg border border-slate-200 p-2 space-y-1.5">
              {stations.map((s: any) => (
                <label key={s.id} className="flex items-center gap-2 cursor-pointer text-sm">
                  <input type="checkbox" checked={form.stationIds.includes(s.id)}
                    onChange={() => setForm(f => ({ ...f, stationIds: toggleIn(f.stationIds, s.id) }))}
                    className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
                  <span className="text-slate-700">{s.name}</span>
                  <span className="text-xs text-slate-400 font-mono">{s.id}</span>
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-400 mt-1">{form.stationIds.length === 0 ? t('tokAllStations') : ''}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="control-label">{t('tokExpiry')}</label>
            <input type="date" value={form.expiresAt}
              onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
              className="field-control mt-1.5 w-full rounded-lg py-2" />
          </div>
          <div>
            <Input label={t('tokIpAllowlist')} value={form.ipAllowlist}
              onChange={e => setForm(f => ({ ...f, ipAllowlist: e.target.value }))}
              placeholder="203.0.113.10, 198.51.100.4" />
          </div>
        </div>
        <p className="text-xs text-slate-400 -mt-3">{t('tokIpHint')}</p>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={() => isCreate ? setShowCreate(false) : setEditing(null)}>{t('cancel')}</Button>
          <Button loading={saving} onClick={() => save(isCreate)}>{t('save')}</Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <p className="text-sm text-slate-400">{t('apiTokensSubtitle')}</p>
        <Button onClick={openCreate}><Plus size={16} /> {t('addApiToken')}</Button>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => <div key={i} className="panel p-5 h-24 animate-pulse" />)}
        </div>
      ) : tokens.length === 0 ? (
        <div className="flex flex-col items-center py-20 gap-4">
          <div className="h-16 w-16 rounded-2xl bg-slate-100 flex items-center justify-center">
            <KeyRound size={28} className="text-slate-400" />
          </div>
          <p className="text-slate-400 text-center max-w-sm">{t('noApiTokensDesc')}</p>
          <Button onClick={openCreate}><Plus size={16} /> {t('addApiToken')}</Button>
        </div>
      ) : (
        <div className="space-y-4">
          {tokens.map((tk: any) => (
            <div key={tk.id} className="panel overflow-hidden">
              <div className="flex items-start gap-4 p-5">
                <div className={cn(
                  'h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0',
                  tk.active && !tk.revokedAt ? 'bg-brand-50 text-brand-600' : 'bg-slate-100 text-slate-400',
                )}>
                  <KeyRound size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-slate-900">{tk.name}</h3>
                    {statusBadge(tk)}
                    <span className="text-xs text-slate-400 font-mono">{tk.tokenPrefix}…</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {(tk.scopes ?? []).map((s: string) => (
                      <span key={s} className="inline-flex items-center rounded-md bg-brand-50 border border-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">
                        {SCOPES.find(x => x.id === s)?.label ?? s}
                      </span>
                    ))}
                  </div>
                </div>
                {!tk.revokedAt && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => toggleActive(tk)} title={tk.active ? t('tokDisable') : t('tokEnable')}
                      className={cn('p-2 rounded-lg transition-colors',
                        tk.active ? 'text-emerald-500 hover:bg-emerald-50' : 'text-slate-400 hover:bg-slate-100')}>
                      <Power size={14} />
                    </button>
                    <button onClick={() => openEdit(tk)}
                      className="p-2 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => setRevoking(tk)}
                      className="p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </div>
              <div className="border-t border-slate-100 bg-slate-50 px-5 py-2.5 flex items-center justify-between text-xs text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Gauge size={12} /> {tk.rateLimitPerMin}/min
                  {tk.expiresAt && <span className="ml-2">· {t('tokExpiry')}: {fmtRelative(tk.expiresAt)}</span>}
                </span>
                <span>{t('tokLastUsed')}: {tk.lastUsedAt ? fmtRelative(tk.lastUsedAt) : t('tokNever')}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title={t('newApiToken')}>
        {renderForm(true)}
      </Modal>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={t('editApiToken')}>
        {renderForm(false)}
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} title={t('tokCreatedTitle')}>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{t('tokCreatedDesc')}</p>
          <div className="flex items-stretch gap-2">
            <code className="flex-1 min-w-0 break-all rounded-lg bg-slate-900 text-emerald-300 text-xs p-3 font-mono">
              {created?.token}
            </code>
            <button onClick={copyToken}
              className="flex-shrink-0 px-3 rounded-lg border border-slate-200 text-slate-500 hover:text-brand-600 hover:border-brand-300 transition-colors">
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => setCreated(null)}>{t('done')}</Button>
          </div>
        </div>
      </Modal>

      <Confirm
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={confirmRevoke}
        loading={saving}
        title={t('tokRevoke')}
        message={`${t('tokRevoke')} "${revoking?.name}"? ${t('tokRevokeConfirm')}`}
        confirmLabel={t('tokRevoke')}
        danger
      />
    </div>
  );
}
