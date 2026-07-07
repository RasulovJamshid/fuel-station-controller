import { SetMetadata } from '@nestjs/common';

/**
 * Fine-grained read scopes carried by an integration API token.
 * An endpoint declares the scope(s) it needs via `@RequireScopes(...)`;
 * the ApiTokenGuard rejects tokens that lack them.
 */
export const API_SCOPES = {
    TRANSACTIONS:  'read:transactions',
    SHIFTS:        'read:shifts',
    PRICES:        'read:prices',
    STATIONS:      'read:stations',
    TANK_READINGS: 'read:tank_readings',
} as const;

export type ApiScope = (typeof API_SCOPES)[keyof typeof API_SCOPES];

export const ALL_API_SCOPES: ApiScope[] = Object.values(API_SCOPES);

export const API_SCOPES_KEY = 'apiScopes';

export const RequireScopes = (...scopes: ApiScope[]) =>
    SetMetadata(API_SCOPES_KEY, scopes);
