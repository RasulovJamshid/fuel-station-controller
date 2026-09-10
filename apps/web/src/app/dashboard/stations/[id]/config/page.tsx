'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Plus, Trash2, Download, Save } from 'lucide-react';
import { stationsApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { configMessages, ConfigLabel } from '@/lib/service-config-i18n';
import { ConfigRecord, configErrorMessage, copySiteSetup, downloadConfig, nextNumber, protocolNames, protocolPresets } from '@/lib/service-config';

type Field = { key: ConfigLabel; type?: 'number' | 'checkbox' | 'password' | 'color'; options?: Record<string, string>; optional?: boolean; fallback?: any; min?: number; max?: number; step?: number };
const number = (key: ConfigLabel, fallback?: number, min = 0, max?: number): Field => ({ key, type: 'number', fallback, min, max });
const checkbox = (key: ConfigLabel, fallback = false): Field => ({ key, type: 'checkbox', fallback });
const choice = (key: ConfigLabel, values: string[], fallback?: string): Field => ({ key, options: Object.fromEntries(values.map(v => [v, v])), fallback });

function Fields({ value, fields, onChange, labels }: {
  value: ConfigRecord; fields: Field[]; onChange: (value: ConfigRecord) => void; labels: typeof configMessages.en;
}) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {fields.map(field => {
      const current = value[field.key] ?? field.fallback ?? '';
      const set = (next: any) => {
        const updated = { ...value, [field.key]: next };
        if (field.optional && next === '') delete updated[field.key];
        onChange(updated);
      };
      if (field.type === 'checkbox') return <label key={field.key} className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={Boolean(current)} onChange={e => set(e.target.checked)} />{labels[field.key]}
      </label>;
      return <label key={field.key} className="flex min-w-0 flex-col gap-1.5">
        <span className="control-label">{labels[field.key]}</span>
        {field.options ? <select className="input-control" value={current} onChange={e => set(field.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}>
          <option value="">{field.optional ? labels.none : '—'}</option>
          {current !== '' && !(String(current) in field.options) && <option value={current}>{String(current)}</option>}
          {Object.entries(field.options).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select> : <input className="input-control" type={field.type ?? 'text'} value={current}
          min={field.min} max={field.max} step={field.step ?? (field.type === 'number' ? 1 : undefined)} autoComplete="off"
          onChange={e => set(field.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)} />}
      </label>;
    })}
  </div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="panel-subtle p-5 space-y-4"><h2 className="text-lg font-semibold text-slate-900">{title}</h2>{children}</section>;
}

export default function SiteConfigPage() {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore(state => state.user);
  const labels = configMessages[(user?.preferences as any)?.language ?? 'ru'] ?? configMessages.ru;
  const canManage = user?.role === 'SUPER_ADMIN' || user?.role === 'COMPANY_ADMIN';
  const [config, setConfig] = useState<ConfigRecord | null>(null);
  const [stations, setStations] = useState<ConfigRecord[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    setConfig(null);
    setError('');
    setDirty(false);
    setSourceId('');
    stationsApi.serviceConfig(id).then((result: any) => {
      if (!cancelled) setConfig(result.config);
    }).catch(e => { if (!cancelled) setError(configErrorMessage(e, labels.error)); });
    stationsApi.list().then((result: any) => {
      if (!cancelled) setStations(result.filter((station: ConfigRecord) => station.id !== id));
    }).catch(e => { if (!cancelled) setError(configErrorMessage(e, labels.error)); });
    return () => { cancelled = true; };
  }, [id, canManage, labels.error]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const update = (next: ConfigRecord) => { setConfig(next); setDirty(true); setMessage(''); setError(''); };
  const copy = async () => {
    if (!config || !sourceId) return;
    setBusy(true); setError('');
    try {
      const result: any = await stationsApi.serviceConfig(sourceId);
      update(copySiteSetup(result.config, config));
      setMessage(labels.copied);
    } catch (e) { setError(configErrorMessage(e, labels.error)); }
    finally { setBusy(false); }
  };
  const save = async (download: boolean) => {
    if (!config) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await stationsApi.saveServiceConfig(id, config);
      setDirty(false);
      setMessage(labels.saved);
      if (download) {
        const result: any = await stationsApi.serviceConfig(id);
        downloadConfig(result.config, id);
      }
    } catch (e) { setError(configErrorMessage(e, labels.saveError)); }
    finally { setBusy(false); }
  };

  if (!canManage) return <p className="p-5 text-slate-600">{labels.denied}</p>;
  if (!config) return <div className="space-y-4"><Link href={`/dashboard/stations/${id}`}>{labels.back}</Link><p role={error ? 'alert' : 'status'}>{error || labels.loading}</p></div>;

  const section = (key: string, value: ConfigRecord | null) => update({ ...config, [key]: value });
  const rows = (key: string): ConfigRecord[] => config[key] ?? [];
  const changeRow = (key: string, index: number, value: ConfigRecord) => update({ ...config, [key]: rows(key).map((row, i) => i === index ? value : row) });
  const removeRow = (key: string, index: number) => update({ ...config, [key]: rows(key).filter((_, i) => i !== index) });
  const addRow = (key: string, value: ConfigRecord) => update({ ...config, [key]: [...rows(key), value] });
  const productOptions = Object.fromEntries(rows('products').map(p => [p.id, `${p.id} · ${p.name}`]));
  const productField: Field = { key: 'product_id', type: 'number', options: productOptions };
  const fields = (value: ConfigRecord, definitions: Field[], onChange: (next: ConfigRecord) => void) => <Fields value={value} fields={definitions} onChange={onChange} labels={labels} />;
  const removeButton = (action: () => void, disabled = false) => <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={action}><Trash2 size={14} />{labels.remove}</Button>;
  const addButton = (action: () => void, disabled = false) => <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={action}><Plus size={14} />{labels.add}</Button>;
  const firstProduct = rows('products')[0]?.id ?? 1;
  const newNozzle = (existing: ConfigRecord[]) => ({ index: nextNumber(existing, 'index'), product_id: firstProduct, price: config.connection.protocol === 'shelf_v2_2' ? 5000 : 10000, active: true });
  const productUsed = (pid: number) => rows('fueling_positions').some(fp => fp.nozzles.some((n: ConfigRecord) => n.product_id === pid)) || rows('tanks').some(t => t.product_id === pid) || config.atg?.branches?.some((b: ConfigRecord) => b.slots.some((s: ConfigRecord) => s.product_id === pid));

  return <div className="space-y-5 pb-8">
    <Header title={labels.title} subtitle={`${config.site.name} · ${id}`} />
    <Link className="inline-flex items-center gap-2 text-sm text-slate-500" href={`/dashboard/stations/${id}`} onClick={e => {
      if (dirty && !window.confirm(labels.unsaved + '. ' + labels.back + '?')) e.preventDefault();
    }}><ArrowLeft size={16} />{labels.back}</Link>
    <p className="text-sm text-slate-600">{labels.intro}</p>
    <p className="rounded-xl border border-brand-100 bg-brand-50 p-4 text-sm text-brand-800">{labels.installation}</p>

    <fieldset disabled={busy} className="space-y-5 min-w-0">
      <Section title={labels.copy}>
        <p className="text-sm text-slate-500">{labels.copyHint}</p>
        <div className="flex flex-wrap items-center gap-3">
          <select aria-label={labels.copy} className="input-control max-w-sm" value={sourceId} onChange={e => setSourceId(e.target.value)}>
            <option value="">{labels.choose}</option>
            {stations.map(station => <option key={station.id} value={station.id}>{station.name} · {station.id}</option>)}
          </select>
          <Button variant="outline" disabled={!sourceId} onClick={copy}>{labels.copyAction}</Button>
        </div>
      </Section>

      <Section title={labels.connection}>
        <p className="text-sm text-slate-500">{labels.protocolHint}</p>
        {fields(config.connection, [{ key: 'protocol', options: protocolNames }, { key: 'port' }, number('baud_rate', undefined, 1), choice('parity', ['none', 'odd', 'even']), number('data_bits', undefined, 5, 8), number('stop_bits', undefined, 1, 2), number('response_timeout_ms', undefined, 1)], next => {
          if (next.protocol !== config.connection.protocol && protocolPresets[next.protocol]) {
            Object.assign(next, protocolPresets[next.protocol], { data_bits: 8, stop_bits: 1 });
            if (config.connection.port.toLowerCase() === 'mock' && next.protocol !== 'mock') next.port = '';
            if (next.protocol === 'mock') next.port = 'mock';
          }
          section('connection', next);
        })}
      </Section>

      <Section title={labels.products}>
        {rows('products').map((product, i) => <div key={i} className="rounded-xl border border-slate-200 p-4 space-y-3">
          {fields(product, [number('id', undefined, 0, 255), { key: 'name' }, { key: 'color', type: 'color' }, { key: 'unit' }], next => changeRow('products', i, next))}
          {removeButton(() => removeRow('products', i), rows('products').length === 1 || productUsed(product.id))}
        </div>)}
        {addButton(() => addRow('products', { id: nextNumber(rows('products'), 'id'), name: '', color: '#2196f3', unit: 'litre' }), rows('products').length >= 255)}
      </Section>

      <Section title={labels.positions}>
        {rows('fueling_positions').map((fp, i) => <div key={i} className="rounded-xl border border-slate-200 p-4 space-y-4">
          {fields(fp, [{ key: 'id' }, { key: 'label' }, number('address_byte', undefined, 0, 255), checkbox('active')], next => changeRow('fueling_positions', i, next))}
          <h3 className="font-medium text-slate-700">{labels.nozzles}</h3>
          {fp.nozzles.map((nozzle: ConfigRecord, j: number) => <div key={j} className="rounded-lg bg-slate-50 p-3 space-y-2">
            {fields(nozzle, [number('index', undefined, 1, 255), productField, number('price', undefined, 0, 4294967295), checkbox('active'),
              ...(config.connection.protocol === 'azt2_0' ? [number('azt_address', 0, 0, 225)] : []),
              ...(config.connection.protocol === 'texnouz_bluesky' ? [number('bluesky_hose_number', 0, 0, 255)] : []),
              ...(config.connection.protocol.startsWith('wayne') ? [number('wayne_code', 0, 0, 255), number('wayne_product_code', 0, 0, 255)] : []),
            ], next => changeRow('fueling_positions', i, { ...fp, nozzles: fp.nozzles.map((n: ConfigRecord, k: number) => k === j ? next : n) }))}
            {removeButton(() => changeRow('fueling_positions', i, { ...fp, nozzles: fp.nozzles.filter((_: ConfigRecord, k: number) => k !== j) }))}
          </div>)}
          <div className="flex justify-between gap-2">
            {addButton(() => changeRow('fueling_positions', i, { ...fp, nozzles: [...fp.nozzles, newNozzle(fp.nozzles)] }), fp.nozzles.length >= 255)}
            {removeButton(() => removeRow('fueling_positions', i), rows('fueling_positions').length === 1)}
          </div>
        </div>)}
        {addButton(() => {
          const positions = rows('fueling_positions');
          let n = 1;
          while (positions.some(fp => fp.id === `FP${n}`)) n++;
          addRow('fueling_positions', { id: `FP${n}`, label: `Pump ${n}`, address_byte: nextNumber(positions, 'address_byte'), active: true, nozzles: [newNozzle([])] });
        })}
      </Section>

      <Section title={labels.tanks}>
        <p className="text-sm text-slate-500">{labels.tankHint}</p>
        {rows('tanks').map((tank, i) => <div key={i} className="rounded-xl border border-slate-200 p-4 space-y-3">
          {fields(tank, [productField, { key: 'label' }, { ...number('capacity_l', undefined, 0), step: 0.01 }, { ...number('current_l', undefined, 0), step: 0.01 }], next => changeRow('tanks', i, next))}
          {removeButton(() => removeRow('tanks', i))}
        </div>)}
        {addButton(() => {
          const product = rows('products').find(p => !rows('tanks').some(t => t.product_id === p.id));
          if (product) addRow('tanks', { product_id: product.id, label: product.name, capacity_l: 20000, current_l: 0 });
        }, !rows('products').some(p => !rows('tanks').some(t => t.product_id === p.id)))}
      </Section>

      <Section title={labels.atg}>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(config.atg)} onChange={e => section('atg', e.target.checked ? { poll_interval_secs: 300, modbus_timeout_secs: 10, api_url: '', auth: null, branches: [] } : null)} />{labels.enabled}</label>
        {config.atg && <>
          {fields(config.atg, [number('poll_interval_secs', 300, 1), { ...number('modbus_timeout_secs', 10, 0), step: 0.1 }, { key: 'api_url', fallback: '' }], next => section('atg', next))}
          <details className="space-y-3"><summary className="cursor-pointer text-sm font-medium">{labels.auth}</summary>
            {fields(config.atg.auth ?? {}, [{ key: 'api_token', type: 'password', fallback: '' }, { key: 'username', fallback: '' }, { key: 'password', type: 'password', fallback: '' }, { key: 'login_url', fallback: '' }], next => section('atg', { ...config.atg, auth: next }))}
          </details>
          <h3 className="font-medium text-slate-700">{labels.branches}</h3>
          {(config.atg.branches ?? []).map((branch: ConfigRecord, i: number) => {
            const changeBranch = (next: ConfigRecord) => section('atg', { ...config.atg, branches: config.atg.branches.map((b: ConfigRecord, j: number) => i === j ? next : b) });
            return <div key={i} className="rounded-xl border border-slate-200 p-4 space-y-4">
              {fields(branch, [number('id', undefined, 0, 4294967295), { key: 'name', fallback: '' }, { key: 'host' }, number('port', 502, 1, 65535), number('unit_id', 1, 0, 255), number('start_register', 1000, 0, 65535), number('address_base', 1, 0, 65535), { key: 'register_count', type: 'number', fallback: 12, options: { 12: '12', 24: '24', 36: '36', 48: '48' } }], changeBranch)}
              <h4 className="text-sm font-medium">{labels.slots}</h4>
              {branch.slots.map((slot: ConfigRecord, j: number) => <div key={j} className="rounded-lg bg-slate-50 p-3 space-y-3">
                {fields(slot, [number('slot', undefined, 1, 4), { ...productField, optional: true }, { key: 'type' }, { key: 'tank_id', optional: true }, { key: 'label', optional: true }, { ...number('capacity_l', undefined, 0), step: 0.01, optional: true }], next => changeBranch({ ...branch, slots: branch.slots.map((s: ConfigRecord, k: number) => j === k ? next : s) }))}
                {removeButton(() => changeBranch({ ...branch, slots: branch.slots.filter((_: ConfigRecord, k: number) => j !== k) }))}
              </div>)}
              <div className="flex justify-between gap-2">
                {addButton(() => {
                  const slot = nextNumber(branch.slots, 'slot', 4);
                  const tank = rows('tanks')[0];
                  const product = rows('products').find(p => p.id === tank?.product_id);
                  changeBranch({ ...branch, register_count: Math.max(branch.register_count ?? 12, slot * 12), slots: [...branch.slots, { slot, type: product?.name ?? '', ...(tank ? { product_id: tank.product_id } : {}) }] });
                }, branch.slots.length >= 4)}
                {removeButton(() => section('atg', { ...config.atg, branches: config.atg.branches.filter((_: ConfigRecord, j: number) => i !== j) }))}
              </div>
            </div>;
          })}
          {addButton(() => section('atg', { ...config.atg, branches: [...(config.atg.branches ?? []), { id: nextNumber(config.atg.branches ?? [], 'id', 4294967295), name: '', host: '', port: 502, unit_id: 1, start_register: 1000, address_base: 1, register_count: 12, slots: [{ slot: 1, type: '' }] }] }))}
        </>}
      </Section>

      <details className="panel-subtle p-5 space-y-5"><summary className="cursor-pointer text-lg font-semibold">{labels.advanced}</summary>
        <h3 className="font-medium">{labels.service}</h3>
        {fields(config.service, [number('port', undefined, 1, 65535), choice('log_level', ['error', 'warn', 'info', 'debug', 'trace']), { key: 'log_file' }, { key: 'db_path' }, { key: 'serial_log_file', optional: true }], next => section('service', next))}
        <h3 className="font-medium">{labels.polling}</h3>
        {fields(config.polling, [number('interval_ms', undefined, 1), number('offline_threshold_polls'), number('reconnect_settle_rounds')], next => section('polling', next))}
        <h3 className="font-medium">{labels.sync}</h3>
        {fields(config.sync, [number('retry_interval_secs', 30), number('batch_size', 100), number('max_retries', 10), number('price_pull_interval_hours', 12), checkbox('price_pull_enabled', true)], next => section('sync', next))}
        <h3 className="font-medium">{labels.ui}</h3>
        {fields(config.ui ?? {}, [choice('default_auth_mode', ['reactive', 'preauth'], 'reactive'), number('preauth_timeout_seconds', 300), checkbox('use_decel_window_on_stop'), checkbox('use_cancel_mode')], next => section('ui', next))}
        <h3 className="font-medium">{labels.shifts}</h3>
        {fields(config.shifts ?? { mode: 'disabled' }, [choice('mode', ['disabled', 'manual', 'scheduled'], 'disabled'), checkbox('require_operator_pin'), number('warn_before_end_minutes', 15), number('allow_overlap_minutes', 30), checkbox('auto_close_on_restart')], next => section('shifts', next))}
        {config.shifts?.mode === 'scheduled' && <div className="space-y-3">
          <h4 className="text-sm font-medium">{labels.schedule}</h4>
          {(config.shifts.scheduled ?? []).map((slot: ConfigRecord, i: number) => <div key={i} className="space-y-2 rounded-lg bg-slate-50 p-3">
            {fields(slot, [{ key: 'name' }, { key: 'start' }, { key: 'end' }], next => section('shifts', { ...config.shifts, scheduled: config.shifts.scheduled.map((s: ConfigRecord, j: number) => i === j ? next : s) }))}
            {removeButton(() => section('shifts', { ...config.shifts, scheduled: config.shifts.scheduled.filter((_: ConfigRecord, j: number) => i !== j) }))}
          </div>)}
          {addButton(() => section('shifts', { ...config.shifts, scheduled: [...(config.shifts.scheduled ?? []), { name: '', start: '08:00', end: '20:00' }] }))}
        </div>}
      </details>
      <details className="panel-subtle p-5"><summary className="cursor-pointer font-semibold">{labels.review}</summary>
        <pre className="mt-4 max-h-96 overflow-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">{JSON.stringify(config, (key, value) => ['api_key', 'api_token', 'password'].includes(key) && value ? '••••••••' : value, 2)}</pre>
      </details>
    </fieldset>

    <div className="sticky bottom-0 z-10 rounded-xl border border-slate-200 bg-white p-4 shadow-lg space-y-3">
      {error && <p role="alert" className="whitespace-pre-line text-sm text-red-600">{error}</p>}
      {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-slate-500">{dirty ? labels.unsaved : config.site.name}</span>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => save(false)}><Save size={15} />{labels.save}</Button>
          <Button loading={busy} onClick={() => save(true)}><Download size={15} />{labels.download}</Button>
        </div>
      </div>
    </div>
  </div>;
}
