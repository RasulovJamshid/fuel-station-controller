'use client';
import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, ShieldCheck, Search, Building2 } from 'lucide-react';
import { usersApi, stationsApi, usersApi2 } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Modal, Confirm } from '@/components/ui/modal';

const ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'STATION_MANAGER', 'ACCOUNTANT'];
const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN:     'Супер-администратор',
  COMPANY_ADMIN:   'Администратор',
  STATION_MANAGER: 'Менеджер станции',
  ACCOUNTANT:      'Бухгалтер',
};
const ROLE_BADGE: Record<string, 'info' | 'warning' | 'neutral' | 'success'> = {
  SUPER_ADMIN:     'danger' as any,
  COMPANY_ADMIN:   'info',
  STATION_MANAGER: 'warning',
  ACCOUNTANT:      'neutral',
};

const EMPTY_FORM = { name: '', email: '', password: '', role: 'STATION_MANAGER' };

export default function UsersPage() {
  const { user: me } = useAuthStore();
  const [users, setUsers]           = useState<any[]>([]);
  const [total, setTotal]           = useState(0);
  const [loading, setLoading]       = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing]       = useState<any>(null);
  const [deleting, setDeleting]     = useState<any>(null);
  const [form, setForm]             = useState(EMPTY_FORM);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');
  const [query, setQuery]           = useState('');

  // Station access management
  const [accessUser, setAccessUser] = useState<any>(null);
  const [allStations, setAllStations] = useState<any[]>([]);
  const [accessSaving, setAccessSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, stations]: any[] = await Promise.all([
        usersApi.list(),
        stationsApi.list(),
      ]);
      setUsers(res.data ?? []);
      setTotal(res.total ?? 0);
      setAllStations(Array.isArray(stations) ? stations : []);
    } finally {
      setLoading(false);
    }
  }, []);

  async function toggleStationAccess(userId: string, stationId: string, hasAccess: boolean) {
    setAccessSaving(stationId);
    try {
      if (hasAccess) {
        await usersApi2.revokeStationAccess(userId, stationId);
      } else {
        await usersApi2.grantStationAccess(userId, stationId);
      }
      // Refresh users to get updated stationAccess
      const res: any = await usersApi.list();
      setUsers(res.data ?? []);
      // Also update the modal user reference
      const updated = (res.data ?? []).find((u: any) => u.id === userId);
      if (updated) setAccessUser(updated);
    } finally {
      setAccessSaving(null);
    }
  }

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setError('');
    setShowCreate(true);
  }

  function openEdit(u: any) {
    setForm({ name: u.name, email: u.email, password: '', role: u.role });
    setError('');
    setEditing(u);
  }

  async function saveCreate() {
    if (!form.name || !form.email || !form.password) { setError('Заполните все поля'); return; }
    setSaving(true); setError('');
    try {
      await usersApi.create({ ...form, companyId: me?.companyId });
      setShowCreate(false);
      load();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Ошибка создания');
    } finally { setSaving(false); }
  }

  async function saveEdit() {
    if (!form.name) { setError('Заполните имя'); return; }
    setSaving(true); setError('');
    try {
      await usersApi.update(editing.id, { name: form.name, role: form.role });
      setEditing(null);
      load();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Ошибка обновления');
    } finally { setSaving(false); }
  }

  async function confirmDelete() {
    setSaving(true);
    try {
      await usersApi.delete(deleting.id);
      setDeleting(null);
      load();
    } finally { setSaving(false); }
  }

  const visibleUsers = users.filter((u: any) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      String(u.name ?? '').toLowerCase().includes(q) ||
      String(u.email ?? '').toLowerCase().includes(q) ||
      String(ROLE_LABELS[u.role] ?? u.role ?? '').toLowerCase().includes(q)
    );
  });

  function renderUserForm(isCreate: boolean) {
    return (
      <div className="space-y-5">
        <Input label="Имя" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        {isCreate && (
          <>
            <Input label="Email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            <Input label="Пароль" type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
          </>
        )}
        <div className="flex flex-col gap-1.5">
          <label className="control-label">Роль</label>
          <select
            value={form.role}
            onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
            className="field-control text-slate-900"
          >
            {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={() => isCreate ? setShowCreate(false) : setEditing(null)}>Отмена</Button>
          <Button loading={saving} onClick={isCreate ? saveCreate : saveEdit}>Сохранить</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <Header title="Пользователи" subtitle={query ? `${visibleUsers.length} из ${total} пользователей` : `${total} пользователей`} />

      <div className="p-2 sm:p-4">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full sm:max-w-sm">
            <Input
              placeholder="Поиск по имени, email, роли"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              icon={<Search size={16} />}
            />
          </div>
          <Button onClick={openCreate} size="md" className="shadow-brand-500/30 shadow-lg">
            <Plus size={18} /> Добавить пользователя
          </Button>
        </div>

        <div className="panel-subtle">
          <table className="w-full text-sm">
            <thead>
              <tr className="table-head-row">
                {['Имя', 'Email', 'Роль', 'Статус', 'Последний вход', ''].map(h => (
                  <th key={h} className="table-head-cell">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j} className="table-cell"><div className="h-4 bg-slate-100 rounded animate-pulse w-24" /></td>
                    ))}
                  </tr>
                ))
              ) : visibleUsers.length === 0 ? (
                <tr><td colSpan={6} className="table-cell py-12 text-center text-sm text-slate-400">Нет пользователей</td></tr>
              ) : (
                visibleUsers.map((u: any) => (
                  <tr key={u.id} className="table-row-hover group">
                    <td className="table-cell">
                      <div className="flex items-center gap-2.5">
                        <div className="h-10 w-10 rounded-full bg-gradient-to-br from-brand-500/20 to-brand-600/20 shadow-sm border border-brand-500/10 flex items-center justify-center text-brand-600 font-bold text-sm flex-shrink-0">
                          {u.name?.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-semibold text-slate-800">{u.name}</span>
                      </div>
                    </td>
                    <td className="table-cell text-slate-500">{u.email}</td>
                    <td className="table-cell">
                      <div className="flex items-center gap-1.5">
                        <ShieldCheck size={13} className="text-slate-400" />
                        <span className="text-slate-700 text-xs">{ROLE_LABELS[u.role] ?? u.role}</span>
                      </div>
                    </td>
                    <td className="table-cell">
                      <Badge variant={u.active ? 'success' : 'neutral'}>
                        {u.active ? 'Активен' : 'Отключён'}
                      </Badge>
                    </td>
                    <td className="table-cell text-xs text-slate-400">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString('ru-RU') : '—'}
                    </td>
                    <td className="table-cell">
                      {u.id !== me?.id && (
                        <div className="flex items-center gap-1 justify-end">
                          <button
                            onClick={() => setAccessUser(u)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                            title="Доступ к станциям"
                          >
                            <Building2 size={14} />
                          </button>
                          <button
                            onClick={() => openEdit(u)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => setDeleting(u)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Новый пользователь">
        {renderUserForm(true)}
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title="Редактировать пользователя">
        {renderUserForm(false)}
      </Modal>

      <Confirm
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        loading={saving}
        title="Удалить пользователя"
        message={`Удалить пользователя ${deleting?.name}? Действие необратимо.`}
        confirmLabel="Удалить"
        danger
      />

      {/* Station access modal */}
      <Modal open={!!accessUser} onClose={() => setAccessUser(null)} title={`Доступ к станциям — ${accessUser?.name}`}>
        {accessUser && (
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              Отметьте станции, к которым пользователь должен иметь доступ.
              Для ролей COMPANY_ADMIN и SUPER_ADMIN доступ ко всем станциям предоставляется автоматически.
            </p>
            {allStations.length === 0 ? (
              <p className="text-sm text-slate-400 py-4 text-center">Нет станций</p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {allStations.map((s: any) => {
                  const hasAccess = (accessUser.stationAccess ?? []).some((a: any) => a.stationId === s.id);
                  return (
                    <label key={s.id} className="flex items-center justify-between p-3 rounded-xl border border-slate-100 hover:bg-slate-50 cursor-pointer gap-3">
                      <div>
                        <p className="text-sm font-medium text-slate-800">{s.name}</p>
                        {s.address && <p className="text-xs text-slate-400">{s.address}</p>}
                      </div>
                      <input
                        type="checkbox"
                        checked={hasAccess}
                        disabled={accessSaving === s.id}
                        onChange={() => toggleStationAccess(accessUser.id, s.id, hasAccess)}
                        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                    </label>
                  );
                })}
              </div>
            )}
            <div className="flex justify-end pt-2">
              <Button variant="outline" onClick={() => setAccessUser(null)}>Закрыть</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
