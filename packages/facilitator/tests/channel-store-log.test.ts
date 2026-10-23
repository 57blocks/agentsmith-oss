import { describe, expect, it } from 'vitest';
import { withoutStoreUrls } from '../src/modules/channels/core/redis-lease-store.js';

describe('store error messages in logs', () => {
  it('replace any store URL, which carries the password', () => {
    expect(withoutStoreUrls('connect to rediss://:S3CRET@cache.example.com:6379/0 failed')).toBe(
      'connect to <store url> failed',
    );
    expect(withoutStoreUrls('Redis://user:pw@host:6379')).toBe('<store url>');
  });

  it('keep messages without a URL unchanged', () => {
    expect(withoutStoreUrls('connect ECONNREFUSED 127.0.0.1:6379')).toBe(
      'connect ECONNREFUSED 127.0.0.1:6379',
    );
  });
});
