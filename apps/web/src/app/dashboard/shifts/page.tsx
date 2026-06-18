'use client';
import { useEffect, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { shiftsApi } from '@/lib/api';
import { useFormats } from '@/hooks/use-formats';
import { useT } from '@/hooks/use-t';
import { Header } from '@/components/layout/header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useWebSocket } from '@/hooks/use-websocket';
import { useOilBases } from '@/hooks/use-oil-bases';

export default function ShiftsPage() {
  const t = useT();
  const { fmtDate, fmtDuration, fmtVolume, fmtMoney } = useFormats();
  const [active, setActive]       = useState<any[]>([]);
  const [history, setHistory]     = useState<any[]>([]);
  const [total, setTotal]         = useState(0);
  const [pages, setPages]         = useState(1);
  const [page, setPage]           = useState(1);
  const [loading, setLoading]     = useState(true);
  const [oilBaseId, setOilBaseId] = useState('');
  const oilBases = useOilBases();

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    const params: any = { page: p, limit: 20 };
    if (oilBaseId) params.oilBaseId = oilBaseId;
    try {
      const [act, hist] = await Promise.all([
        shiftsApi.active(undefined, oilBaseId || undefined),
        shiftsApi.list(params),
      ]);
      setActive(Array.isArray(act) ? act : []);
      const h = hist as any;
      setHistory(h.data ?? []);
      setTotal(h.total ?? 0);
      setPages(h.pages ?? 1);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(1); setPage(1); }, [oilBaseId]); // eslint-disable-line
  useEffect(() => { load(page); }, [page]); // eslint-disable-line

  const { connected } = useWebSocket(useCallback((ev: string) => {
    if (ev === 'shift.synced') load(page);
  }, [load, page]));

  return (
    <div className="animate-fade-in">
      <Header title={t('navShifts')} subtitle={`${total} ${t('shiftsTotal')}`} connected={connected} />

      <div className="p-2 sm:p-4 space-y-8">
        {/* Filter bar */}
        {oilBases.length > 0 && (
          <div className="panel p-4 flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-500">{t('oilBase')}</label>
              <select
                value={oilBaseId}
                onChange={e => setOilBaseId(e.target.value)}
                className="field-control appearance-none"
              >
                <option value="">{t('all')}</option>
                {oilBases.map(ob => <option key={ob.id} value={ob.id}>{ob.name}</option>)}
              </select>
            </div>
            {oilBaseId && (
              <Button variant="ghost" size="sm" onClick={() => setOilBaseId('')}>{t('reset')}</Button>
            )}
          </div>
        )}

        {/* Active shifts */}
        {active.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-3">{t('activeShiftsSection')}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {active.map((s: any) => (
                <div key={s.id} className="panel border-l-4 border-l-emerald-400 p-6 transition-all duration-200 hover:shadow-md group">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="font-semibold text-slate-900">{s.operatorName}</p>
                      <p className="text-xs text-slate-500">{s.stationId}</p>
                    </div>
                    <Badge variant="success">{t('activeShift')}</Badge>
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-slate-400">{t('shiftStart')}</p>
                      <p className="font-medium text-slate-700">{fmtDate(s.startedAt)}</p>
                    </div>
                    <div>
                      <p className="text-slate-400">{t('shiftDuration')}</p>
                      <p className="font-medium text-slate-700">{fmtDuration(s.startedAt)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* History table */}
        <div>
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-3">{t('shiftHistory')}</h2>
          <div className="panel-subtle">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="table-head-row">
                    {[t('shiftOperator'), t('station'), t('shiftStart'), t('shiftEnd'), t('shiftTx'), t('shiftVolume'), t('shiftAmount'), t('status')].map(h => (
                      <th key={h} className="table-head-cell whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {loading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: 8 }).map((_, j) => (
                          <td key={j} className="table-cell">
                            <div className="h-4 bg-slate-100 rounded animate-pulse w-20" />
                          </td>
                        ))}
                      </tr>
                    ))
                  ) : history.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="table-cell py-12 text-center text-sm text-slate-400">{t('noData')}</td>
                    </tr>
                  ) : (
                    history.map((s: any) => (
                      <tr key={s.id} className="table-row-hover group">
                        <td className="table-cell font-medium text-slate-800">{s.operatorName}</td>
                        <td className="table-cell text-slate-600">{s.stationId}</td>
                        <td className="table-cell text-xs text-slate-500 whitespace-nowrap">{fmtDate(s.startedAt)}</td>
                        <td className="table-cell text-xs text-slate-500 whitespace-nowrap">{s.endedAt ? fmtDate(s.endedAt) : '—'}</td>
                        <td className="table-cell text-slate-700">{s.totalTransactions}</td>
                        <td className="table-cell font-mono text-slate-700">{fmtVolume(s.totalVolume)}</td>
                        <td className="table-cell font-mono text-slate-700 whitespace-nowrap">{fmtMoney(s.totalAmount)}</td>
                        <td className="table-cell">
                          <Badge variant={s.status === 'ACTIVE' ? 'success' : 'neutral'}>
                            {s.status === 'ACTIVE' ? t('activeShift') : t('done')}
                          </Badge>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 bg-slate-50">
              <p className="text-xs text-slate-500">{t('showing')} {history.length} {t('of')} {total}</p>
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
      </div>
    </div>
  );
}
