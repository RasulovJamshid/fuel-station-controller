'use client';

import { Button } from '@/components/ui/button';
import { ConfigRecord, nextNumber, protocolNames, protocolPresets } from '@/lib/service-config';
import { configMessages } from '@/lib/service-config-i18n';
import { setupMessages, SetupMessages } from '@/lib/service-setup-i18n';
import { assignNozzleTank, hoseAddressKey, mapSensor, newSetupNozzle, SetupIssue, tankId, updateNozzle, updatePosition, updateTank, validateSetup } from '@/lib/service-setup';

const get = (obj: any, path: string): any => path.split('.').reduce((o, key) => o?.[key], obj);
function put(obj: any, path: string[], value: any): any {
  if (!path.length) return value;
  const [key, ...rest] = path;
  const next = Array.isArray(obj) ? [...obj] : { ...obj };
  next[key as any] = put(obj?.[key], rest, value);
  return next;
}
export const setupIssueText = (issue: SetupIssue, messages: SetupMessages) =>
  String((messages as any)[issue.code] ?? issue.code).replace('{min}', String(issue.min)).replace('{max}', String(issue.max));

type Props = { config: ConfigRecord; onChange: (config: ConfigRecord) => void; language: string; step: number; onStepChange: (step: number) => void };
export function ServiceConfigWizard({ config, onChange, language, step, onStepChange }: Props) {
  const labels = configMessages[language] ?? configMessages.ru;
  const text = setupMessages[language] ?? setupMessages.ru;
  const issues = validateSetup(config);
  const positions: ConfigRecord[] = config.fueling_positions;
  const tanks: ConfigRecord[] = config.tanks ?? [];
  const products: ConfigRecord[] = config.products;
  const protocol = config.connection.protocol;
  const addressKey = hoseAddressKey(protocol);
  const productOptions = Object.fromEntries(products.map(p => [p.id, p.name || String(p.id)]));
  const tankOptions = Object.fromEntries(tanks.map(t => [tankId(t), t.label]));
  const change = (path: string, value: any) => {
    const parts = path.split('.');
    if (parts[0] === 'tanks' && parts.length > 2) {
      const i = Number(parts[1]);
      onChange(updateTank(config, i, put(tanks[i], parts.slice(2), value)));
    } else onChange(put(config, parts, value));
  };
  const go = (next: number, focus?: string) => {
    onStepChange(next);
    requestAnimationFrame(() => {
      const field = focus && document.getElementById(`setup.${focus}`);
      if (field) {
        let parent = field.parentElement;
        while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
        field.scrollIntoView({ block: 'center' }); field.focus();
      } else document.getElementById('setup-heading')?.focus();
    });
  };
  const field = (path: string, label: string, type: 'text' | 'number' | 'checkbox' | 'color' = 'text', options?: Record<string, string>, apply?: (v: any) => void, fallback?: any) => {
    const value = get(config, path) ?? fallback ?? '';
    const errors = issues.filter(i => i.path === path);
    const id = `setup.${path}`;
    const props = { id, 'aria-invalid': errors.length > 0, 'aria-describedby': errors.length ? `${id}.error` : undefined };
    const set = apply ?? ((v: any) => change(path, v));
    return <div className="min-w-0 space-y-1.5" key={path}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">{label}</label>
      {type === 'checkbox' ? <input {...props} type="checkbox" checked={Boolean(value)} onChange={e => set(e.target.checked)} className="h-5 w-5" /> : options ?
        <select {...props} className={`input-control ${errors.length ? 'border-red-400' : ''}`} value={value} onChange={e => set(type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}>
          {!Object.hasOwn(options, '') && <option value="">—</option>}
          {value !== '' && !Object.hasOwn(options, String(value)) && <option value={value}>{String(value)}</option>}
          {Object.entries(options).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
        </select> : <input {...props} className={`input-control ${errors.length ? 'border-red-400' : ''}`} type={type} value={value} step={type === 'number' ? 'any' : undefined}
          onChange={e => set(type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)} />}
      {errors.length > 0 && <p id={`${id}.error`} className="text-sm text-red-700">{setupIssueText(errors[0], text)}</p>}
    </div>;
  };
  const remove = (action: () => void, disabled = false) => <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={action}>{labels.remove}</Button>;
  const add = (label: string, action: () => void, disabled = false) => <Button type="button" variant="outline" disabled={disabled} onClick={action}>{label}</Button>;
  const grid = 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3';
  const card = 'rounded-xl border border-slate-200 bg-white p-4 space-y-4';
  const sourceTank = (fp: ConfigRecord, nozzle: ConfigRecord) => tanks.find(t => t.nozzle_sources?.some((s: ConfigRecord) => s.fp_id === fp.id && s.nozzle_index === nozzle.index));
  const issueLabel = (issue: SetupIssue) => {
    const [section, i, child, j, key] = issue.path.split('.');
    const name = (field: string) => (labels as any)[field] ?? field;
    if (section === 'fueling_positions') {
      const fp = positions[Number(i)];
      return `${fp?.label ?? labels.positions} / ${child === 'nozzles' ? `${labels.nozzles} ${fp?.nozzles[Number(j)]?.index} / ${name(key)}` : name(child ?? 'positions')}`;
    }
    if (section === 'tanks') return `${tanks[Number(i)]?.label ?? labels.tanks} / ${name(child ?? 'label')}`;
    if (section === 'products') return `${products[Number(i)]?.name || labels.products} / ${name(child ?? 'name')}`;
    if (section === 'atg' && i === 'branches') {
      const branch = config.atg?.branches[Number(child)];
      return `${branch?.name || text.controller} ${Number(child) + 1} / ${j === 'slots' ? `${text.sensor} ${branch?.slots[Number(key)]?.slot} / ${name(issue.path.split('.')[5])}` : name(j)}`;
    }
    return name(i ?? section);
  };
  const removeTank = (i: number) => {
    const id = tankId(tanks[i]);
    onChange({ ...config, tanks: tanks.filter((_, j) => i !== j), atg: config.atg && { ...config.atg,
      branches: config.atg.branches.map((b: ConfigRecord) => ({ ...b, slots: b.slots.filter((s: ConfigRecord) => s.tank_id !== id) })),
    } });
  };

  return <div className="space-y-5">
    <nav aria-label={text.guided} className="grid grid-cols-2 gap-2 lg:grid-cols-6">
      {text.steps.map((name, i) => {
        const count = i === 5 ? issues.length : issues.filter(issue => issue.step === i).length;
        return <button key={name} type="button" aria-current={step === i ? 'step' : undefined} onClick={() => go(i)}
          className={`rounded-xl border p-3 text-left text-sm transition-colors ${step === i ? 'border-brand-500 bg-brand-50 text-brand-900' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>
          <span className="block font-semibold">{i + 1}. {name}</span>
          <span className={`mt-1 block text-xs ${count ? 'text-amber-700' : 'text-slate-500'}`}>{count ? `${text.needsAttention} (${count})` : text.ready}</span>
        </button>;
      })}
    </nav>
    <section className="panel-subtle p-5 space-y-5">
      <div><h2 id="setup-heading" tabIndex={-1} className="text-xl font-semibold text-slate-900 outline-none">{text.steps[step]}</h2><p className="mt-2 text-base text-slate-600">{text.hints[step]}</p></div>

      {step === 0 && <>
        <div className={grid}>
          {field('connection.protocol', labels.protocol, 'text', protocolNames, value => {
            const connection = { ...config.connection, protocol: value, data_bits: 8, stop_bits: 1, ...protocolPresets[value] };
            if (value === 'mock') connection.port = 'mock'; else if (connection.port.toLowerCase() === 'mock') connection.port = '';
            change('connection', connection);
          })}
          {field('connection.port', labels.port)}
        </div>
        <p className="text-sm text-slate-600">{protocolNames[protocol]} · {config.connection.baud_rate} baud · {config.connection.data_bits} / {config.connection.parity} / {config.connection.stop_bits}</p>
        <details open={issues.some(i => i.step === 0 && i.path !== 'connection.port') || undefined} className={card}><summary className="cursor-pointer font-medium">{text.advanced}</summary><div className={grid}>
          {field('connection.baud_rate', labels.baud_rate, 'number')}
          {field('connection.parity', labels.parity, 'text', { none: 'none', odd: 'odd', even: 'even' })}
          {field('connection.data_bits', labels.data_bits, 'number')}{field('connection.stop_bits', labels.stop_bits, 'number')}
          {field('connection.response_timeout_ms', labels.response_timeout_ms, 'number')}
        </div></details>
      </>}

      {step === 1 && <>
        <p className="rounded-lg bg-brand-50 p-3 text-sm text-brand-900">{addressKey ? text.hoseAddress : protocol.startsWith('wayne') ? text.wayneAddress : text.sharedAddress}</p>
        {positions.map((fp, i) => <div key={i} className={card}>
          <div className={grid}>
            {field(`fueling_positions.${i}.label`, labels.label)}
            {field(`fueling_positions.${i}.address_byte`, labels.address_byte, 'number')}
            {field(`fueling_positions.${i}.active`, labels.active, 'checkbox')}
          </div>
          <details open><summary className="cursor-pointer text-sm font-semibold">{labels.nozzles} ({fp.nozzles.length})</summary>
            <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[420px] text-left"><thead><tr className="text-sm text-slate-500"><th className="p-2">{labels.nozzles}</th><th className="p-2">{labels.connection}</th><th /></tr></thead><tbody>
              {fp.nozzles.map((n: ConfigRecord, j: number) => {
                const path = `fueling_positions.${i}.nozzles.${j}`;
                return <tr key={j} className="border-t border-slate-100 align-top">
                  <td className="w-32 p-2">{field(`${path}.index`, labels.index, 'number', undefined, value => onChange(updateNozzle(config, i, j, { ...n, index: value })))}</td>
                  <td className="p-2"><div className="flex flex-wrap gap-3">
                    {addressKey && field(`${path}.${addressKey}`, (labels as any)[addressKey], 'number', undefined, undefined, 0)}
                    {protocol.startsWith('wayne') && <>{field(`${path}.wayne_code`, labels.wayne_code, 'number', undefined, undefined, 0)}{field(`${path}.wayne_product_code`, labels.wayne_product_code, 'number', undefined, undefined, 0)}</>}
                    {field(`${path}.active`, labels.active, 'checkbox')}
                  </div></td>
                  <td className="p-2">{remove(() => onChange(updatePosition(config, i, { ...fp, nozzles: fp.nozzles.filter((_: any, k: number) => k !== j) })))}</td>
                </tr>;
              })}
            </tbody></table></div>
          </details>
          <div className="flex flex-wrap justify-between gap-3">
            {add(text.addNozzle, () => change(`fueling_positions.${i}.nozzles`, [...fp.nozzles, newSetupNozzle(config, fp.nozzles)]), fp.nozzles.length >= (protocol === 'shelf_v2_2' ? 5 : 255))}
            {remove(() => onChange({ ...config, fueling_positions: positions.filter((_, j) => i !== j), tanks: tanks.map(t => ({ ...t, nozzle_sources: (t.nozzle_sources ?? []).filter((s: ConfigRecord) => s.fp_id !== fp.id) })) }), positions.length <= 1)}
          </div>
          <details><summary className="cursor-pointer text-sm text-slate-600">{text.advanced}</summary><div className="mt-3">{field(`fueling_positions.${i}.id`, labels.id, 'text', undefined, value => onChange(updatePosition(config, i, { ...fp, id: value })))}</div></details>
        </div>)}
        {add(text.addPump, () => {
          let id = 1; while (positions.some(p => p.id === `FP${id}`)) id++;
          change('fueling_positions', [...positions, { id: `FP${id}`, label: `Pump ${id}`, address_byte: nextNumber(positions, 'address_byte'), active: true, nozzles: [newSetupNozzle(config, [])] }]);
        }, positions.length >= 255)}
      </>}

      {step === 2 && <>
        <p className="text-sm text-slate-600">{text.equipmentOnly}</p>
        {!tanks.length && <p className="rounded-xl border border-dashed border-slate-300 p-5 text-slate-600">{text.tankEmpty}</p>}
        {tanks.map((tank, i) => <div className={card} key={tankId(tank)}>
          <div className={grid}>
            {field(`tanks.${i}.label`, labels.name)}{field(`tanks.${i}.capacity_l`, labels.capacity_l, 'number')}
            {field(`tanks.${i}.product_id`, `${labels.product_id} (${text.optional})`, 'number', { '': text.noProduct, ...productOptions }, value => change(`tanks.${i}.product_id`, value === '' ? null : value))}
          </div>
          <details><summary className="cursor-pointer text-sm text-slate-600">{text.advanced}</summary><div className="mt-3 space-y-3">
            <p className="text-sm text-slate-500">{labels.tank_id}: {tankId(tank)}</p>
            {field(`tanks.${i}.current_l`, labels.current_l, 'number')}
          </div></details>
          {remove(() => removeTank(i))}
        </div>)}
        {add(text.addTank, () => change('tanks', [...tanks, { tank_id: crypto.randomUUID(), label: `Tank ${tanks.length + 1}`, product_id: null, capacity_l: 25000, current_l: 0 }]))}
      </>}

      {step === 3 && <>
        {field('atg.enabled', labels.enabled, 'checkbox', undefined, enabled => change('atg', {
          poll_interval_secs: 300, modbus_timeout_secs: 10, api_url: '', export_enabled: false, branches: [], ...config.atg, enabled,
        }))}
        {config.atg && <>
          <p className="text-sm text-slate-600">{text.atgEmpty}</p>
          <details><summary className="cursor-pointer font-medium">{text.advanced}</summary><div className={`${grid} mt-3`}>
            {field('atg.poll_interval_secs', labels.poll_interval_secs, 'number', undefined, undefined, 300)}
            {field('atg.modbus_timeout_secs', labels.modbus_timeout_secs, 'number', undefined, undefined, 10)}
            {field('atg.stale_after_secs', labels.stale_after_secs, 'number', undefined, value => change('atg.stale_after_secs', value === '' ? null : value))}
          </div></details>
          {(config.atg.branches ?? []).map((b: ConfigRecord, i: number) => {
            const path = `atg.branches.${i}`;
            return <div className={card} key={i}>
              <h3 className="font-semibold">{text.controller} {i + 1} · Modbus TCP</h3>
              <div className={grid}>{field(`${path}.name`, labels.name)}{field(`${path}.host`, labels.host)}{field(`${path}.port`, labels.port, 'number', undefined, undefined, 502)}</div>
              <details><summary className="cursor-pointer text-sm font-medium">{text.advanced}</summary><div className={`${grid} mt-3`}>
                {field(`${path}.unit_id`, labels.unit_id, 'number', undefined, undefined, 1)}
                {field(`${path}.start_register`, labels.start_register, 'number', undefined, undefined, 1000)}
                {field(`${path}.address_base`, labels.address_base, 'number', { '0': '0', '1': '1' }, undefined, 1)}
                {field(`${path}.register_count`, labels.register_count, 'number', undefined, undefined, 12)}
                {field(`${path}.word_order`, labels.word_order, 'text', Object.fromEntries(['ABCD', 'CDAB', 'BADC', 'DCBA'].map(v => [v, v])), undefined, 'ABCD')}
                {field(`${path}.height_unit`, labels.height_unit, 'text', { mm: 'mm', m: 'm' }, undefined, 'mm')}
              </div></details>
              {b.slots.map((slot: ConfigRecord, j: number) => {
                const sp = `${path}.slots.${j}`;
                return <div key={j} className="rounded-lg bg-slate-50 p-3 space-y-3">
                  <div className={grid}>
                    {field(`${sp}.slot`, text.sensor, 'number', undefined, value => change(path, { ...b,
                      register_count: Math.max(b.register_count ?? 12, typeof value === 'number' && value <= 5461 ? value * 12 : 12),
                      slots: b.slots.map((s: ConfigRecord, k: number) => j === k ? { ...s, slot: value } : s),
                    }))}
                    {field(`${sp}.tank_id`, text.tank, 'text', tankOptions, id => {
                      const tank = tanks.find(t => tankId(t) === id);
                      if (tank) change(sp, mapSensor(slot, tank, products));
                    })}
                  </div>
                  <details><summary className="cursor-pointer text-sm text-slate-600">{text.advanced}</summary><div className="mt-3">{field(`${sp}.type`, labels.type)}</div></details>
                  {remove(() => change(`${path}.slots`, b.slots.filter((_: any, k: number) => k !== j)))}
                </div>;
              })}
              <div className="flex flex-wrap justify-between gap-3">
                {add(text.addSensor, () => {
                  const slot = nextNumber(b.slots, 'slot', 5461);
                  const tank = tanks.find(t => !config.atg.branches.some((branch: ConfigRecord) => branch.slots.some((s: ConfigRecord) => s.tank_id === tankId(t))));
                  const next = { slot, type: '' };
                  change(path, { ...b, register_count: Math.max(b.register_count ?? 12, slot * 12), slots: [...b.slots, tank ? mapSensor(next, tank, products) : next] });
                }, b.slots.length >= 5461)}
                {remove(() => change('atg.branches', config.atg.branches.filter((_: any, j: number) => i !== j)))}
              </div>
            </div>;
          })}
          {add(text.addController, () => {
            const branches = config.atg.branches ?? [];
            change('atg.branches', [...branches, { id: nextNumber(branches, 'id', 4294967295), name: '', host: '', port: 502, unit_id: 1, start_register: 1000, address_base: 1, register_count: 12, word_order: 'ABCD', height_unit: 'mm', slots: [] }]);
          })}
        </>}
      </>}

      {step === 4 && <>
        <p className="text-sm text-slate-600">{text.equipmentOnly}</p>
        <div className={card}><h3 className="font-semibold">{labels.products}</h3>
          {products.map((p, i) => <div className="flex flex-wrap items-end gap-3" key={i}>
            {field(`products.${i}.name`, labels.name)}{field(`products.${i}.color`, labels.color, 'color')}
            {remove(() => change('products', products.filter((_, j) => i !== j)), products.length <= 1 || positions.some(fp => fp.nozzles.some((n: ConfigRecord) => n.product_id === p.id)) || tanks.some(t => t.product_id === p.id) || config.atg?.branches?.some((b: ConfigRecord) => b.slots.some((s: ConfigRecord) => s.product_id === p.id)))}
          </div>)}
          {add(text.addProduct, () => change('products', [...products, { id: nextNumber(products, 'id'), name: '', color: '#2196f3', unit: 'litre' }]), products.length >= 255)}
        </div>
        {positions.map((fp, i) => <div className={card} key={i}><h3 className="font-semibold">{fp.label} · {fp.id}</h3>
          {fp.nozzles.map((n: ConfigRecord, j: number) => <div key={j} className="rounded-lg bg-slate-50 p-3 space-y-3">
            <h4 className="text-sm font-semibold">{labels.nozzles} {n.index}</h4>
            <div className={grid}>
              {field(`fueling_positions.${i}.nozzles.${j}.product_id`, labels.product_id, 'number', productOptions)}
              {field(`fueling_positions.${i}.nozzles.${j}.price`, labels.price, 'number')}
              <div className="space-y-1.5"><label htmlFor={`tank-source-${i}-${j}`} className="block text-sm font-medium text-slate-700">{text.tank}</label>
                <select id={`tank-source-${i}-${j}`} className="input-control" value={sourceTank(fp, n) ? tankId(sourceTank(fp, n)!) : ''} onChange={e => onChange(assignNozzleTank(config, fp.id, n.index, e.target.value))}>
                  <option value="">{text.noTank}</option>{tanks.map(t => <option key={tankId(t)} value={tankId(t)}>{t.label}</option>)}
                </select>
              </div>
            </div>
          </div>)}
        </div>)}
      </>}

      {step === 5 && <>
        <div className={`rounded-xl border p-4 ${issues.length ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
          <p className="font-medium">{issues.length ? text.fixErrors : text.noErrors}</p>
          {issues.length > 0 && <ul className="mt-3 space-y-2">{issues.map((issue, i) => <li key={i}><button type="button" className="text-left text-sm underline" onClick={() => go(issue.step, issue.path)}>{issueLabel(issue)}: {setupIssueText(issue, text)}</button></li>)}</ul>}
        </div>
        <div className={card}><h3 className="font-semibold">{labels.connection}</h3><p>{protocolNames[protocol]} · {config.connection.port} · {config.connection.baud_rate} baud</p></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-sm"><thead><tr>{[labels.positions, labels.index, labels.product_id, labels.price, text.tank].map(h => <th className="p-3" key={h}>{h}</th>)}</tr></thead><tbody>
          {positions.flatMap(fp => fp.nozzles.map((n: ConfigRecord) => <tr key={`${fp.id}/${n.index}`} className="border-t border-slate-200"><td className="p-3">{fp.label} ({fp.address_byte})</td><td className="p-3">{n.index}{addressKey ? ` / ${n[addressKey] || (protocol === 'texnouz_bluesky' ? fp.address_byte + n.index : fp.address_byte)}` : ''}</td><td className="p-3">{productOptions[n.product_id] ?? '—'}</td><td className="p-3">{n.price}</td><td className="p-3">{sourceTank(fp, n)?.label ?? text.noTank}</td></tr>))}
        </tbody></table></div>
        {tanks.map(tank => {
          const controller = config.atg?.branches?.find((b: ConfigRecord) => b.slots.some((s: ConfigRecord) => s.tank_id === tankId(tank)));
          const sensor = controller?.slots.find((s: ConfigRecord) => s.tank_id === tankId(tank));
          return <div key={tankId(tank)} className={card}><p className="font-semibold">{tank.label} · {tank.capacity_l} L</p><p className="text-sm text-slate-600">{productOptions[tank.product_id] ?? text.noProduct} · ATG: {controller ? `${controller.host}:${controller.port ?? 502} / ${text.sensor} ${sensor.slot}` : labels.none}</p></div>;
        })}
        <p className="text-sm text-slate-600">{text.exportHint}</p>
        <details><summary className="cursor-pointer font-medium">{text.raw}</summary><pre className="mt-3 max-h-96 overflow-auto rounded-xl bg-slate-900 p-4 text-xs text-slate-100">{JSON.stringify(config, (key, value) => ['api_key', 'api_token', 'password'].includes(key) && value ? '••••••••' : value, 2)}</pre></details>
      </>}
    </section>
    <div className="flex justify-between gap-3"><Button variant="outline" disabled={step === 0} onClick={() => go(step - 1)}>{text.previous}</Button>{step < 5 && <Button onClick={() => go(step + 1)}>{text.next}</Button>}</div>
  </div>;
}
