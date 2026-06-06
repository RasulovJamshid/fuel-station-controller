'use client';
import { useEffect, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { transactionsApi } from '@/lib/api';
import { fmtVolume, fmtMoney, fmtDate } from '@/lib/format';
import { Header } from '@/components/layout/header';
import { TxStatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useWebSocket } from '@/hooks/use-websocket';

const STATUSES = ['', 'COMPLETED', 'STOPPED', 'ABORTED'];

export default function TransactionsPage() {
  const [data, setData]     = useState<any[]>([]);
  const [total, setTotal]   = useState(0);
  const [pages, setPages]   = useState(1);
  const [page, setPage]     = useState(1);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [from, setFrom]     = useState('');
  const [to, setTo]         = useState('');

  const load = useCallback(async (p = page) => {
    setLoading(true);
    try {
      const params: any = { page: p, limit: 50 };
      if (status) params.status = [status];
      if (from)   params.from   = new Date(from).toISOString();
      if (to)     params.to     = new Date(to).toISOString();
      const res: any = await transactionsApi.list(params);
      setData(res.data ?? []);
      setTotal(res.total ?? 0);
      setPages(res.pages ?? 1);
    } finally {
      setLoading(false);
    }
  }, [page, status, from, to]);

  useEffect(() => { load(1); setPage(1); }, [status, from, to]); // eslint-disable-line
  useEffect(() => { load(page); }, [page]); // eslint-disable-line

  const { connected } = useWebSocket();

  return (
    <div className="animate-fade-in">
      <Header title="Транзакции" subtitle={`${total.toLocaleString()} записей`} connected={connected} />

      <div className="p-2 sm:p-4 space-y-6">
        {/* Filters */}
        <div className="panel p-5 flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-500">С</label>
            <input
              type="date"
              value={from}
              onChange={e => setFrom(e.target.value)}
              className="field-control"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-500">По</label>
            <input
              type="date"
              value={to}
              onChange={e => setTo(e.target.value)}
              className="field-control"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-500">Статус</label>
            <select
              value={status}
              onChange={e => setStatus(e.target.value)}
              className="field-control appearance-none"
            >
              {STATUSES.map(s => (
                <option key={s} value={s}>{s || 'Все'}</option>
              ))}
            </select>
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setFrom(''); setTo(''); setStatus(''); }}>
              Сбросить
            </Button>
          </div>
        </div>

        {/* Table */}
        <div className="panel-subtle">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="table-head-row">
                  {['Время', 'Станция', 'КЗ', 'Продукт', 'Объём', 'Цена', 'Сумма', 'Оператор', 'Статус'].map(h => (
                    <th key={h} className="table-head-cell whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {loading ? (
                  Array.from({ length: 10 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 9 }).map((_, j) => (
                        <td key={j} className="table-cell">
                          <div className="h-4 bg-slate-100 rounded animate-pulse" style={{ width: `${60 + Math.random() * 40}px` }} />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : data.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="table-cell py-12 text-center text-sm text-slate-400">
                      Транзакций не найдено
                    </td>
                  </tr>
                ) : (
                  data.map((tx: any) => (
                    <tr key={tx.id} className="table-row-hover group">
                      <td className="table-cell text-xs text-slate-500 whitespace-nowrap">{fmtDate(tx.startedAt)}</td>
                      <td className="table-cell font-medium text-slate-800">{tx.stationId}</td>
                      <td className="table-cell text-slate-600">{tx.label}</td>
                      <td className="table-cell text-slate-700">{tx.productName}</td>
                      <td className="table-cell font-mono text-slate-700">{fmtVolume(tx.volume)}</td>
                      <td className="table-cell font-mono text-slate-500 text-xs">{tx.price}</td>
                      <td className="table-cell font-mono text-slate-700 whitespace-nowrap">{fmtMoney(tx.amount)}</td>
                      <td className="table-cell text-slate-600">{tx.operatorName ?? '—'}</td>
                      <td className="table-cell"><TxStatusBadge status={tx.status} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 bg-slate-50">
            <p className="text-xs text-slate-500">
              Показано {data.length} из {total}
            </p>
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
  );
}
