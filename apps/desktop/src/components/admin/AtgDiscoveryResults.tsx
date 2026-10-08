import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AtgBranchInfo, AtgConfigSnapshot } from '../../types/api';
import { scannedSlotMapping, type AtgScanDevice, type AtgTankSelection } from '../../lib/atgDiscovery';

type Choice = Omit<AtgTankSelection, 'product_id'> & { selected: boolean; product_id: number | '' };
const input = 'w-full min-w-0 rounded border border-border-primary bg-bg-primary px-2 py-1.5 text-sm disabled:opacity-50';

export function AtgDiscoveryResults({ config, profile, devices, products, onAdd, onClose }: {
  config: AtgConfigSnapshot; profile: AtgBranchInfo; devices: AtgScanDevice[];
  products: { id: number; name: string }[];
  onAdd: (selections: AtgTankSelection[]) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const resultRef = useRef<HTMLElement>(null);
  useEffect(() => { resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, []);
  const label = (key: string) => t(`admin.atg.scan.${key}`);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const keyFor = (host: string, slot: number) => `${host}/${slot}`;
  const choiceFor = (host: string, slot: number): Choice => choices[keyFor(host, slot)] ?? {
    host, slot, selected: false, label: `${label('tank')} ${slot}`, product_id: '', capacity_l: 25000,
  };
  const change = (host: string, slot: number, patch: Partial<Choice>) => setChoices(current => ({
    ...current,
    [keyFor(host, slot)]: { ...(current[keyFor(host, slot)] ?? choiceFor(host, slot)), ...patch },
  }));
  const selected = Object.values(choices).filter(c => c.selected);
  const ready = selected.length > 0 && selected.every(c => c.product_id !== '' && c.label.trim() && Number.isFinite(c.capacity_l) && c.capacity_l > 0);
  const availableTanks = config.tanks.filter(tank => !config.branches.some(b => b.slots.some(s => s.tank_id === tank.tank_id)));
  return <section ref={resultRef} className="space-y-3 rounded-lg border border-accent-blue/40 bg-bg-secondary/30 p-3">
    <div className="flex items-center justify-between gap-2"><h4 className="font-semibold">{label('results')}</h4><button type="button" onClick={onClose} className="text-sm text-text-secondary">{label('close')}</button></div>
    <p className="text-xs text-text-muted">{label('hint')}</p>
    {devices.length === 0 && <p role="status" className="text-sm">{t('admin.atg.noneFound')}</p>}
    {devices.map(device => <div key={device.host} className="space-y-2">
      <h5 className="font-mono text-sm font-semibold">{device.host}:{profile.port}</h5>
      {device.error ? <p className="text-sm text-accent-red">{device.error}</p> : device.tanks.length === 0 ? <p className="text-sm text-text-muted">{label('noTanks')}</p> :
        <div className="overflow-x-auto"><table className="w-full text-left text-xs">
          <thead className="text-text-muted"><tr>{['select', 'slot', 'volume', 'target', 'name', 'product', 'capacity'].map(key => <th key={key} className="p-2 font-medium">{label(key)}</th>)}</tr></thead>
          <tbody>{device.tanks.map(tank => {
            const mapping = scannedSlotMapping(config, profile, device.host, tank.slot);
            const choice = choiceFor(device.host, tank.slot);
            const configured = mapping && config.tanks.find(t => t.tank_id === mapping.tank_id);
            return <tr key={tank.slot} className="border-t border-border-primary/50">
              <td className="p-2"><input type="checkbox" aria-label={`${label('select')} ${device.host} / ${tank.slot}`} checked={choice.selected} disabled={!!mapping} onChange={e => change(device.host, tank.slot, { selected: e.target.checked })} /></td>
              <td className="p-2 font-mono">{tank.slot}</td><td className="whitespace-nowrap p-2 font-mono">{tank.product_volume.toFixed(1)} L</td>
              {mapping ? <td colSpan={4} className="p-2 text-text-muted">{label('alreadyAdded')}: {configured?.label ?? mapping.label ?? mapping.tank_id ?? mapping.type}</td> : <>
                <td className="min-w-36 p-2"><select aria-label={label('target')} className={input} value={choice.tank_id ?? ''} onChange={e => {
                  const existing = config.tanks.find(t => t.tank_id === e.target.value);
                  change(device.host, tank.slot, existing ? { tank_id: existing.tank_id, label: existing.label, product_id: existing.product_id, capacity_l: existing.capacity_l }
                    : { tank_id: undefined, label: `${label('tank')} ${tank.slot}`, product_id: '', capacity_l: 25000 });
                }}><option value="">{label('newTank')}</option>{availableTanks.map(existing => <option key={existing.tank_id} value={existing.tank_id} disabled={selected.some(c => c.tank_id === existing.tank_id && keyFor(c.host, c.slot) !== keyFor(device.host, tank.slot))}>{existing.label}</option>)}</select></td>
                <td className="min-w-36 p-2"><input aria-label={label('name')} className={input} value={choice.label} onChange={e => change(device.host, tank.slot, { label: e.target.value })} /></td>
                <td className="min-w-32 p-2"><select aria-label={label('product')} className={input} disabled={!!choice.tank_id} value={choice.product_id} onChange={e => change(device.host, tank.slot, { product_id: e.target.value === '' ? '' : Number(e.target.value) })}><option value="">{label('chooseProduct')}</option>{products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
                <td className="min-w-28 p-2"><input aria-label={label('capacity')} type="number" min="0.01" step="any" className={input} value={choice.capacity_l} onChange={e => change(device.host, tank.slot, { capacity_l: Number(e.target.value) })} /></td>
              </>}
            </tr>;
          })}</tbody>
        </table></div>}
    </div>)}
    <button type="button" className="rounded bg-accent-blue px-3 py-2 text-sm font-semibold text-white disabled:opacity-40" disabled={!ready} onClick={() => onAdd(selected.map(c => ({ ...c, product_id: Number(c.product_id) })))}>{t('admin.atg.scan.addSelected', { count: selected.length })}</button>
  </section>;
}
