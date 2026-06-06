import axios, { AxiosError } from 'axios';
import { useAuthStore } from '@/store/auth';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export const api = axios.create({ baseURL: `${BASE}/api/v1` });

api.interceptors.request.use(cfg => {
  const token = useAuthStore.getState().token;
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

api.interceptors.response.use(
  res => res.data?.data ?? res.data,
  async (err: AxiosError) => {
    if (err.response?.status === 401) {
      const refresh = useAuthStore.getState().refreshToken;
      if (refresh) {
        try {
          const res = await axios.post(`${BASE}/api/v1/auth/refresh`, { refreshToken: refresh });
          const { accessToken, refreshToken } = (res.data as any).data;
          useAuthStore.getState().setTokens(accessToken, refreshToken);
          err.config!.headers!.Authorization = `Bearer ${accessToken}`;
          return api.request(err.config!);
        } catch {
          useAuthStore.getState().logout();
          window.location.href = '/login';
        }
      } else {
        useAuthStore.getState().logout();
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  },
);

// ── Auth ──────────────────────────────────────────────────────────────────────

export const authApi = {
  login:             (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  me:                () => api.get('/auth/me'),
  changePassword:    (currentPassword: string, newPassword: string) =>
    api.post('/auth/change-password', { currentPassword, newPassword }),
  updatePreferences: (prefs: Record<string, unknown>) =>
    api.put('/users/preferences', prefs),
};

// ── Dashboard ─────────────────────────────────────────────────────────────────

export const dashboardApi = {
  overview: () => api.get('/dashboard/overview'),
};

// ── Transactions ──────────────────────────────────────────────────────────────

export const transactionsApi = {
  list:    (params: Record<string, unknown>) => api.get('/transactions', { params }),
  summary: (params: Record<string, unknown>) => api.get('/transactions/summary', { params }),
};

// ── Stations ──────────────────────────────────────────────────────────────────

export const stationsApi = {
  list:      () => api.get('/stations'),
  get:       (id: string) => api.get(`/stations/${id}`),
  create:    (data: unknown) => api.post('/stations', data),
  update:    (id: string, data: unknown) => api.put(`/stations/${id}`, data),
  delete:    (id: string) => api.delete(`/stations/${id}`),
  rotateKey: (id: string) => api.post(`/stations/${id}/rotate-key`),
};

// ── Shifts ────────────────────────────────────────────────────────────────────

export const shiftsApi = {
  list:   (params?: Record<string, unknown>) => api.get('/shifts', { params }),
  active: (stationId?: string) =>
    api.get('/shifts/active', { params: stationId ? { stationId } : {} }),
};

// ── Reservoirs ────────────────────────────────────────────────────────────────

export const reservoirsApi = {
  list:   (stationId?: string) =>
    api.get('/reservoirs', { params: stationId ? { stationId } : {} }),
  latest: (stationId?: string) =>
    api.get('/reservoirs/latest', { params: stationId ? { stationId } : {} }),
  create: (data: unknown) => api.post('/reservoirs', data),
};

// ── Users ─────────────────────────────────────────────────────────────────────

export const usersApi = {
  list:   (params?: Record<string, unknown>) => api.get('/users', { params }),
  create: (data: unknown) => api.post('/users', data),
  update: (id: string, data: unknown) => api.put(`/users/${id}`, data),
  delete: (id: string) => api.delete(`/users/${id}`),
};

// ── Reports ───────────────────────────────────────────────────────────────────

export const reportsApi = {
  revenue:   (params: Record<string, unknown>) => api.get('/reports/revenue', { params }),
  operators: (params: Record<string, unknown>) => api.get('/reports/operators', { params }),
  products:  (params: Record<string, unknown>) => api.get('/reports/products', { params }),
};
