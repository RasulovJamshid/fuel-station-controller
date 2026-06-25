export type Lang = 'ru' | 'uz' | 'en';

const units = {
  ru: {
    litres: 'л', m3: 'м³',
    mln: 'млн сум', sum: 'сум',
    justNow: 'только что',
    minAgo: 'мин. назад', hrAgo: 'ч. назад', dayAgo: 'д. назад',
    min: 'мин', hr: 'ч', minAbbr: 'м',
  },
  uz: {
    litres: 'l', m3: 'm³',
    mln: "mln so'm", sum: "so'm",
    justNow: 'hozirgina',
    minAgo: 'min. oldin', hrAgo: 'soat oldin', dayAgo: 'kun oldin',
    min: 'min', hr: 'soat', minAbbr: 'm',
  },
  en: {
    litres: 'l', m3: 'm³',
    mln: 'mln sum', sum: 'sum',
    justNow: 'just now',
    minAgo: 'min. ago', hrAgo: 'hr. ago', dayAgo: 'day(s) ago',
    min: 'min', hr: 'hr', minAbbr: 'm',
  },
};

export function formatMoneyInput(value: number | string | null | undefined): string {
  if (value == null || value === '') return '';
  const raw = typeof value === 'number' ? String(Math.trunc(value)) : value;
  const digits = raw.replace(/[^\d-]/g, '');
  if (digits === '' || digits === '-') return raw;
  const sign = digits.startsWith('-') ? '-' : '';
  const body = sign ? digits.slice(1) : digits;
  return `${sign}${body.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
}

export function parseMoneyInput(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value;
  if (value == null) return 0;
  const parsed = Number.parseFloat(value.replace(/\s/g, '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createFormatters(lang: Lang = 'ru') {
  const u = units[lang] ?? units.ru;

  return {
    fmtVolume(litres: number): string {
      if (litres >= 1000) return `${(litres / 1000).toFixed(2)} ${u.m3}`;
      return `${litres.toFixed(1)} ${u.litres}`;
    },

    fmtMoney(uzs: number | bigint): string {
      const sum = Number(uzs);
      if (sum >= 1_000_000) return `${(sum / 1_000_000).toFixed(2)} ${u.mln}`;
      return new Intl.NumberFormat('ru-UZ', { maximumFractionDigits: 0 }).format(sum) + ` ${u.sum}`;
    },

    fmtDate(iso: string): string {
      return new Date(iso).toLocaleString('ru-UZ', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    },

    fmtDateShort(iso: string): string {
      return new Date(iso).toLocaleDateString('ru-UZ', {
        day: '2-digit', month: 'short',
      });
    },

    fmtRelative(iso: string): string {
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60_000);
      if (mins < 1) return u.justNow;
      if (mins < 60) return `${mins} ${u.minAgo}`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs} ${u.hrAgo}`;
      return `${Math.floor(hrs / 24)} ${u.dayAgo}`;
    },

    fmtDuration(startIso: string, endIso?: string | null): string {
      const end = endIso ? new Date(endIso) : new Date();
      const mins = Math.floor((end.getTime() - new Date(startIso).getTime()) / 60_000);
      if (mins < 60) return `${mins} ${u.min}`;
      return `${Math.floor(mins / 60)}${u.hr} ${mins % 60}${u.minAbbr}`;
    },
  };
}

const _ru = createFormatters('ru');
export const fmtVolume   = _ru.fmtVolume;
export const fmtMoney    = _ru.fmtMoney;
export const fmtDate     = _ru.fmtDate;
export const fmtDateShort = _ru.fmtDateShort;
export const fmtRelative = _ru.fmtRelative;
export const fmtDuration = _ru.fmtDuration;
