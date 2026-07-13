'use client';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Clock, Droplets, Receipt, TrendingUp } from 'lucide-react';
import { shiftsApi } from '@/lib/api';
import { useFormats } from '@/hooks/use-formats';
import { useT } from '@/hooks/use-t';
import { Header } from '@/components/layout/header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useWebSocket } from '@/hooks/use-websocket';

export default function ShiftDetailPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { fmtDate, fmtDuration, fmtVolume, fmtMoney } = useFormats();
  const [shift, setShift] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setShift(await shiftsApi.get(id)); }
    catch (e: any) { setError(e?.response?.data?.message ?? t('loadError')); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useWebSocket(useCallback((event: string) => {
    if (event === 'shift.synced') load();
  }, [load]));

  if (loading) return <><Header title={t('loading')} /><div className="p-6"><div className="panel h-48 animate-pulse" /></div></>;
  if (error || !shift) return <><Header title={t('error')} /><div className="p-6"><Button variant="outline" onClick={() => router.back()}><ArrowLeft size={16} /> {t('back')}</Button><p className="mt-4 text-red-600">{error}</p></div></>;

  const active = shift.status === 'ACTIVE';
  const cards = [
    [Receipt, t('shiftTx'), String(shift.totalTransactions)],
    [Droplets, t('shiftVolume'), fmtVolume(shift.totalVolume)],
    [TrendingUp, t('shiftAmount'), fmtMoney(shift.totalAmount)],
    [Clock, t('shiftDuration'), fmtDuration(shift.startedAt, shift.endedAt)],
  ] as const;

  return (
    <div className="animate-fade-in">
      <Header title={shift.shiftName || t('activeShift')} subtitle={shift.stationId} />
      <div className="p-2 sm:p-4 space-y-6">
        <div className="flex items-center justify-between">
          <button onClick={() => router.back()} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft size={16} /> {t('navShifts')}</button>
          <Badge variant={active ? 'success' : 'neutral'}>{active ? t('activeShift') : t('done')}</Badge>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {cards.map(([Icon, label, value]) => <div key={label} className="panel-subtle p-5 flex gap-4 items-center"><Icon size={20} className="text-brand-500" /><div><p className="text-xs text-slate-500 uppercase">{label}</p><p className="text-xl font-bold text-slate-900">{value}</p></div></div>)}
        </div>
        <div className="panel-subtle p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div><p className="text-slate-400">{t('shiftOperator')}</p><p className="font-medium text-slate-800">{shift.operatorName}</p></div>
          <div><p className="text-slate-400">{t('shiftStart')}</p><p className="font-medium text-slate-800">{fmtDate(shift.startedAt)}</p></div>
          <div><p className="text-slate-400">{t('shiftEnd')}</p><p className="font-medium text-slate-800">{shift.endedAt ? fmtDate(shift.endedAt) : '—'}</p></div>
          {shift.notes && <div><p className="text-slate-400">Notes</p><p className="font-medium text-slate-800">{shift.notes}</p></div>}
        </div>
        {(shift.positionTotals?.length ?? 0) > 0 && <div className="panel-subtle overflow-hidden"><div className="panel-header"><h2 className="font-semibold">{t('fp')}</h2></div><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="table-head-row"><th className="table-head-cell">{t('fp')}</th><th className="table-head-cell">{t('shiftTx')}</th><th className="table-head-cell">{t('shiftVolume')}</th><th className="table-head-cell">{t('shiftAmount')}</th></tr></thead><tbody>{shift.positionTotals.map((p: any) => <tr key={p.id} className="table-row-hover"><td className="table-cell">{p.label}</td><td className="table-cell">{p.transactionsCount}</td><td className="table-cell">{fmtVolume(p.totalVolume)}</td><td className="table-cell">{fmtMoney(p.totalAmount)}</td></tr>)}</tbody></table></div></div>}
      </div>
    </div>
  );
}
