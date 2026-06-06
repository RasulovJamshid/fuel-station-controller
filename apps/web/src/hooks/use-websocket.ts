'use client';
import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/store/auth';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:4000';

export function useWebSocket(onEvent?: (event: string, data: unknown) => void) {
  const token = useAuthStore(s => s.token);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!token) return;

    const socket = io(`${WS_URL}/dashboard`, {
      auth: { token },
      reconnectionDelay: 3000,
    });

    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    const events = [
      'transaction.synced', 'shift.synced', 'tank.updated',
      'export.ready', 'export.failed',
    ];

    events.forEach(ev => {
      socket.on(ev, (data: unknown) => onEvent?.(ev, data));
    });

    return () => { socket.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return { connected, socket: socketRef.current };
}
