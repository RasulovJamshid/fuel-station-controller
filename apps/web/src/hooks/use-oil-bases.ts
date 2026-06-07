'use client';
import { useState, useEffect } from 'react';
import { oilBasesApi } from '@/lib/api';

export interface OilBaseOption {
  id: string;
  name: string;
}

export function useOilBases() {
  const [oilBases, setOilBases] = useState<OilBaseOption[]>([]);

  useEffect(() => {
    oilBasesApi.list().then((res: any) => {
      setOilBases(Array.isArray(res) ? res.map((ob: any) => ({ id: ob.id, name: ob.name })) : []);
    }).catch(() => {});
  }, []);

  return oilBases;
}
