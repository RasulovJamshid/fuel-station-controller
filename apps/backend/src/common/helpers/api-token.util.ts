import { createHash, randomBytes } from 'crypto';

/**
 * Integration API tokens.
 *
 * A token is a high-entropy random string prefixed with `azs_live_`.
 * The plaintext is returned to the caller exactly once (at creation);
 * only its SHA-256 hash is persisted, so a database leak cannot be
 * replayed against the API. SHA-256 (not bcrypt) is used deliberately:
 * the token has ~192 bits of entropy, so a fast one-way hash is both
 * secure and cheap enough to verify on every request.
 */
export const API_TOKEN_LIVE_PREFIX = 'azs_live_';

export interface GeneratedApiToken {
    /** Plaintext token — show to the caller once, never store. */
    token:       string;
    /** SHA-256 hex digest of the plaintext — this is what we store. */
    tokenHash:   string;
    /** Short, non-secret identifier for display in listings. */
    tokenPrefix: string;
}

export function generateApiToken(): GeneratedApiToken {
    const body  = randomBytes(24).toString('base64url'); // 32 url-safe chars
    const token = `${API_TOKEN_LIVE_PREFIX}${body}`;
    return {
        token,
        tokenHash:   hashApiToken(token),
        tokenPrefix: `${API_TOKEN_LIVE_PREFIX}${body.slice(0, 6)}`,
    };
}

export function hashApiToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
