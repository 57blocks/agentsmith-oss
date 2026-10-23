import { createHash, createHmac, randomBytes } from 'node:crypto';

/** A new Resource Server API key: `fsk_` and 32 random bytes, so scanners can spot a leak. */
export function newApiKey(): string {
  return `fsk_${randomBytes(32).toString('base64url')}`;
}

/** What `api_credentials.secret_digest` stores for a key: 32 bytes of SHA-256. */
export function apiKeyDigest(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

/**
 * What `registration_source.ip_digest` stores: HMAC-SHA-256 of the IP. Keyed, because every IPv4
 * address can be hashed in minutes, so a plain hash would store the IP in all but name.
 */
export function registrationSourceDigest(ip: string, key: string): Buffer {
  return createHmac('sha256', key).update(ip).digest();
}
