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
  detail:    (id: string) => api.get(`/stations/${id}/detail`),
  create:    (data: unknown) => api.post('/stations', data),
  update:    (id: string, data: unknown) => api.put(`/stations/${id}`, data),
  delete:    (id: string) => api.delete(`/stations/${id}`),
  rotateKey: (id: string) => api.post(`/stations/${id}/rotate-key`),
};

// ── Shifts ────────────────────────────────────────────────────────────────────

export const shiftsApi = {
  list:   (params?: Record<string, unknown>) => api.get('/shifts', { params }),
  active: (stationId?: string, oilBaseId?: string) => {
    const params: Record<string, string> = {};
    if (stationId) params.stationId = stationId;
    if (oilBaseId) params.oilBaseId = oilBaseId;
    return api.get('/shifts/active', { params });
  },
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
  export:    (params: Record<string, unknown>) => api.get('/export', { params, responseType: 'blob' }),
};

// ── Prices ────────────────────────────────────────────────────────────────────

export const pricesApi = {
  current: (stationId?: string) =>
    api.get('/prices', { params: stationId ? { stationId } : {} }),
  history: (params?: Record<string, unknown>) =>
    api.get('/prices/history', { params }),
  set: (data: {
    stationId: string; fpId: string; nozzleIndex: number;
    productId: number; productName: string; price: number;
  }) => api.post('/prices', data),
};

export const usersApi2 = {
  grantStationAccess:  (userId: string, stationId: string) =>
    api.post(`/users/${userId}/station-access/${stationId}`),
  revokeStationAccess: (userId: string, stationId: string) =>
    api.delete(`/users/${userId}/station-access/${stationId}`),
};

// ── Integrations ──────────────────────────────────────────────────────────────

export const integrationsApi = {
  list:      () => api.get('/integrations'),
  create:    (data: unknown) => api.post('/integrations', data),
  update:    (id: string, data: unknown) => api.put(`/integrations/${id}`, data),
  remove:    (id: string) => api.delete(`/integrations/${id}`),
  test:      (id: string) => api.post(`/integrations/${id}/test`),
  deliveries:(id: string) => api.get(`/integrations/${id}/deliveries`),
};

// ── Integration API tokens ──────────────────────────────────────────────────────

export const apiTokensApi = {
  list:   () => api.get('/api-tokens'),
  create: (data: unknown) => api.post('/api-tokens', data),
  update: (id: string, data: unknown) => api.patch(`/api-tokens/${id}`, data),
  remove: (id: string) => api.delete(`/api-tokens/${id}`),
};

// ── Oil Bases ─────────────────────────────────────────────────────────────────

export const oilBasesApi = {
  list:          ()                                    => api.get('/oil-bases'),
  summary:       ()                                    => api.get('/oil-bases/summary'),
  get:           (id: string)                          => api.get(`/oil-bases/${id}`),
  create:        (data: unknown)                       => api.post('/oil-bases', data),
  update:        (id: string, data: unknown)           => api.put(`/oil-bases/${id}`, data),
  delete:        (id: string)                          => api.delete(`/oil-bases/${id}`),
  assignStation: (id: string, stationId: string)       => api.post(`/oil-bases/${id}/stations/${stationId}`),
  detachStation: (id: string, stationId: string)       => api.delete(`/oil-bases/${id}/stations/${stationId}`),
};

// ── Alert Rules ───────────────────────────────────────────────────────────────

export const alertRulesApi = {
  list:   () => api.get('/alert-rules'),
  create: (data: unknown) => api.post('/alert-rules', data),
  update: (id: string, data: unknown) => api.put(`/alert-rules/${id}`, data),
  delete: (id: string) => api.delete(`/alert-rules/${id}`),
};
