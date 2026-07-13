'use client';
import { useEffect, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, TrendingUp, TrendingDown, Pencil } from 'lucide-react';
import { pricesApi } from '@/lib/api';
import { useFormats } from '@/hooks/use-formats';
import { useT } from '@/hooks/use-t';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { formatMoneyInput, parseMoneyInput } from '@/lib/format';

export default function PricesPage() {
  const t = useT();
  const { fmtDate } = useFormats();

  const [current, setCurrent]   = useState<any[]>([]);
  const [history, setHistory]   = useState<any[]>([]);
  const [total, setTotal]       = useState(0);
  const [pages, setPages]       = useState(1);
  const [page, setPage]         = useState(1);
  const [loading, setLoading]   = useState(true);

  const [editing, setEditing]   = useState<any>(null);
  const [editPrice, setEditPrice] = useState('');
  const [saving, setSaving]     = useState(false);
  const [editError, setEditError] = useState('');

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const [cur, hist] = await Promise.all([
        pricesApi.current(),
        pricesApi.history({ page: p, limit: 50 }),
      ]);
      setCurrent(Array.isArray(cur) ? cur : []);
      const h = hist as any;
      setHistory(h.data ?? []);
      setTotal(h.total ?? 0);
      setPages(h.pages ?? 1);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(page); }, [page, load]);

  function fmtPrice(uzs: number) {
    return new Intl.NumberFormat('ru-UZ').format(uzs) + ` ${t('sumPerLiter')}`;
  }

  function openEdit(row: any) {
    setEditing(row);
    setEditPrice(formatMoneyInput(row.price));
    setEditError('');
  }

  async function saveEdit() {
    const p = Math.trunc(parseMoneyInput(editPrice));
    if (!p || p <= 0) { setEditError(t('invalidPrice')); return; }
    setSaving(true); setEditError('');
    try {
      await pricesApi.set({
        stationId:   editing.stationId,
        fpId:        editing.fpId,
        nozzleIndex: editing.nozzleIndex,
        productId:   editing.productId,
        productName: editing.productName,
        price:       p,
      });
      setEditing(null);
      load(page);
    } catch (e: any) {
      setEditError(e?.response?.data?.message ?? t('saveError'));
    } finally { setSaving(false); }
  }

  return (
    <div className="animate-fade-in">
      <Header title={t('fuelPrices')} />

      <div className="p-6 space-y-6">
        {/* Current prices */}
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100">
            <h2 className="font-semibold text-slate-900">{t('currentPrices')}</h2>
            <p className="text-xs text-slate-400 mt-0.5">{t('priceEditHint')}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  {[t('station'), t('fp'), t('product'), t('price'), t('updatedAt'), t('updatedBy'), ''].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {loading ? Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-slate-100 rounded animate-pulse w-20" /></td>
                  ))}</tr>
                )) : current.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">{t('noPriceData')}</td></tr>
                ) : current.map((p: any, i) => (
                  <tr key={i} className="hover:bg-slate-50 transition-colors group">
                    <td className="px-4 py-3 font-medium text-slate-800">{p.stationName ?? p.stationId}</td>
                    <td className="px-4 py-3 text-slate-600">{p.fpId} / {p.nozzleIndex}</td>
                    <td className="px-4 py-3 text-slate-700">
                      <p className="font-medium">{p.canonicalProductName ?? p.productName}</p>
                      {p.canonicalProductName && <p className="text-xs text-slate-400">{p.productName}</p>}
                    </td>
                    <td className="px-4 py-3 font-mono font-semibold text-slate-900">{fmtPrice(p.price)}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{fmtDate(p.updatedAt)}</td>
                    <td className="px-4 py-3 text-slate-500">{p.source === 'transaction' ? t('observedTransaction') : p.updatedBy}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => openEdit(p)}
                        className="p-1.5 rounded-lg text-slate-300 group-hover:text-brand-500 hover:bg-brand-50 transition-colors"
                        title={t('editPrice')}
                      >
                        <Pencil size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Price change history */}
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h2 className="font-semibold text-slate-900">{t('priceHistory')}</h2>
            <span className="text-xs text-slate-400">{total} {t('records')}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  {[t('date'), t('station'), t('product'), t('oldPrice'), t('newPrice'), t('priceChange'), t('source')].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {loading ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-slate-100 rounded animate-pulse w-20" /></td>
                  ))}</tr>
                )) : history.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">{t('noPriceHistory')}</td></tr>
                ) : history.map((r: any, i) => {
                  const delta = r.newPrice - r.oldPrice;
                  return (
                    <tr key={i} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{fmtDate(r.changedAt)}</td>
                      <td className="px-4 py-3 text-slate-700">{r.stationId}</td>
                      <td className="px-4 py-3 text-slate-700">{r.productName}</td>
                      <td className="px-4 py-3 font-mono text-slate-500">{fmtPrice(r.oldPrice)}</td>
                      <td className="px-4 py-3 font-mono font-semibold text-slate-900">{fmtPrice(r.newPrice)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs font-semibold ${delta > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                          {delta > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                          {delta > 0 ? '+' : ''}{fmtPrice(Math.abs(delta)).replace(` ${t('sumPerLiter')}`, '')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{r.source} / {r.changedBy}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 bg-slate-50">
            <p className="text-xs text-slate-500">{t('showingOf')} {history.length} {t('of')} {total}</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                <ChevronLeft size={14} />
              </Button>
              <span className="text-sm text-slate-700">{page} / {pages}</span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Price edit modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={t('editPrice')}>
        {editing && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              <span className="font-medium">{editing.productName}</span> — {editing.fpId} / nozzle {editing.nozzleIndex}
            </p>
            <p className="text-xs text-slate-400">{t('station')}: {editing.stationId}</p>
            <Input
              label={t('newPriceLabel')}
              type="text"
              inputMode="numeric"
              value={editPrice}
              onChange={e => setEditPrice(formatMoneyInput(e.target.value))}
              autoFocus
            />
            {editError && <p className="text-sm text-red-600">{editError}</p>}
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline" onClick={() => setEditing(null)}>{t('cancel')}</Button>
              <Button loading={saving} onClick={saveEdit}>{t('save')}</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
