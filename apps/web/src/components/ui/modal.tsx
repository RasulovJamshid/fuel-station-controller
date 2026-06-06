'use client';
import { useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export function Modal({ open, onClose, title, children, size = 'md' }: ModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (open) document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm" onClick={onClose} />
      <div className={cn(
        'panel-subtle relative w-full animate-slide-up max-h-[90vh] flex flex-col shadow-xl',
        size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-2xl' : 'max-w-lg',
      )}>
        <div className="panel-header flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            className="icon-button p-1.5 text-slate-400 hover:text-slate-600"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-4 sm:px-5 py-4 sm:py-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}


interface ConfirmProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}

export function Confirm({ open, onClose, onConfirm, title, message, confirmLabel = 'Подтвердить', danger, loading }: ConfirmProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <p className="text-sm text-slate-700 font-medium mb-6">{message}</p>
      <div className="flex gap-3 justify-end mt-2">
        <Button
          onClick={onClose}
          variant="outline"
          size="md"
        >
          Отмена
        </Button>
        <Button
          onClick={onConfirm}
          loading={loading}
          variant={danger ? 'danger' : 'primary'}
          size="md"
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
