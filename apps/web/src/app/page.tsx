'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth';

export default function Root() {
  const router = useRouter();
  const token = useAuthStore(s => s.token);
  useEffect(() => {
    router.replace(token ? '/dashboard' : '/login');
  }, [token, router]);
  return null;
}
