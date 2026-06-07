'use client';
import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { CheckCircle, XCircle, AlertCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastType = 'success' | 'error' | 'warning';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  success: (msg: string) => void;
  error:   (msg: string) => void;
  warning: (msg: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const icons = { success: CheckCircle, error: XCircle, warning: AlertCircle };
const styles = {
  success: 'bg-white border-emerald-200 text-emerald-800',
  error:   'bg-white border-red-200   text-red-800',
  warning: 'bg-white border-amber-200 text-amber-800',
};
const iconStyles = { success: 'text-emerald-500', error: 'text-red-500', warning: 'text-amber-500' };

let _id = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const add = useCallback((type: ToastType, message: string) => {
    const id = ++_id;
    setToasts(t => [...t, { id, type, message }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
  }, []);

  const remove = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);

  const value: ToastContextValue = {
    success: msg => add('success', msg),
    error:   msg => add('error', msg),
    warning: msg => add('warning', msg),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => {
          const Icon = icons[t.type];
          return (
            <div
              key={t.id}
              className={cn(
                'flex items-start gap-3 rounded-xl border shadow-lg px-4 py-3 text-sm font-medium max-w-sm w-full pointer-events-auto animate-slide-up',
                styles[t.type],
              )}
            >
              <Icon size={16} className={cn('flex-shrink-0 mt-0.5', iconStyles[t.type])} />
              <span className="flex-1">{t.message}</span>
              <button onClick={() => remove(t.id)} className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity">
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
