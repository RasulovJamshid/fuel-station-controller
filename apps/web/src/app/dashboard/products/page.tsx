'use client';
import { useCallback, useEffect, useState } from 'react';
import { Link2, Package, Plus, Trash2 } from 'lucide-react';
import { productsApi } from '@/lib/api';
import { useT } from '@/hooks/use-t';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { useAuthStore } from '@/store/auth';

export default function ProductsPage() {
  const t = useT();
  const role = useAuthStore(s => s.user?.role);
  const canManage = role === 'SUPER_ADMIN' || role === 'COMPANY_ADMIN';
  const [products, setProducts] = useState<any[]>([]);
  const [stationProducts, setStationProducts] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ code: '', name: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [catalog, discovered] = await Promise.all([productsApi.list(), productsApi.discovered()]);
    setProducts(Array.isArray(catalog) ? catalog : []);
    setStationProducts(Array.isArray(discovered) ? discovered : []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!form.code.trim() || !form.name.trim()) return;
    setSaving(true);
    try { await productsApi.create(form); setShowForm(false); setForm({ code: '', name: '' }); await load(); }
    finally { setSaving(false); }
  }

  async function map(row: any, canonicalProductId: string) {
    if (!canonicalProductId) {
      if (row.mappingId) await productsApi.unmap(row.mappingId);
    } else {
      await productsApi.map(canonicalProductId, {
        stationId: row.stationId,
        stationProductId: row.stationProductId,
        stationProductName: row.stationProductName,
      });
    }
    await load();
  }

  return <div className="animate-fade-in">
    <Header title={t('productCatalog')} subtitle={t('productCatalogHint')} />
    <div className="p-2 sm:p-4 space-y-6">
      <div className="flex justify-end">{canManage && <Button onClick={() => setShowForm(true)}><Plus size={16} /> {t('addProduct')}</Button>}</div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {products.map(product => <div key={product.id} className="panel-subtle p-5">
          <div className="flex items-start gap-3"><div className="p-2 rounded-lg bg-brand-50 text-brand-600"><Package size={18} /></div><div className="flex-1"><p className="font-semibold text-slate-900">{product.name}</p><p className="text-xs text-slate-400">{product.code}</p></div></div>
          <div className="mt-4 space-y-1.5">{product.mappings?.length ? product.mappings.map((m: any) => <div key={m.id} className="flex items-center gap-2 text-xs text-slate-600"><Link2 size={12} className="text-slate-400" /><span>{m.station.name}: {m.stationProductName}</span>{canManage && <button className="ml-auto text-slate-300 hover:text-red-500" onClick={async () => { await productsApi.unmap(m.id); load(); }}><Trash2 size={12} /></button>}</div>) : <p className="text-xs text-amber-600">{t('noProductMappings')}</p>}</div>
        </div>)}
      </div>

      <div className="panel-subtle overflow-hidden">
        <div className="panel-header"><h2 className="font-semibold text-slate-900">{t('stationProductMappings')}</h2><p className="text-xs text-slate-400 mt-1">{t('stationProductMappingsHint')}</p></div>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="table-head-row"><th className="table-head-cell">{t('station')}</th><th className="table-head-cell">{t('stationProduct')}</th><th className="table-head-cell">{t('canonicalProduct')}</th></tr></thead><tbody className="divide-y divide-slate-50">
          {stationProducts.map((row, i) => <tr key={`${row.stationId}-${row.stationProductId}-${i}`} className="table-row-hover"><td className="table-cell">{row.stationName}</td><td className="table-cell"><p className="font-medium">{row.stationProductName}</p><p className="text-xs text-slate-400">ID: {row.stationProductId}</p></td><td className="table-cell"><select disabled={!canManage} value={row.canonicalProductId ?? ''} onChange={e => map(row, e.target.value)} className="field-control min-w-48"><option value="">{t('unmapped')}</option>{products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}</select></td></tr>)}
          {stationProducts.length === 0 && <tr><td colSpan={3} className="table-cell text-center py-10 text-slate-400">{t('noData')}</td></tr>}
        </tbody></table></div>
      </div>
    </div>
    <Modal open={showForm} onClose={() => setShowForm(false)} title={t('addProduct')}><div className="space-y-4"><Input label={t('productCode')} value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} placeholder="AI92" /><Input label={t('name')} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="AI-92" /><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setShowForm(false)}>{t('cancel')}</Button><Button loading={saving} onClick={create}>{t('save')}</Button></div></div></Modal>
  </div>;
}
