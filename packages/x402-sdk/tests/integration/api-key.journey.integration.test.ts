import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ApiKeyManager,
  ApiKeyRequestError,
  createResourceServer,
  ResourceServerInitializationError,
} from 'agentsmith-x402-sdk/seller';

// Opt-in: every run registers a Resource Server on the hosted Facilitator.
const enabled = process.env.SDK_API_KEY_E2E === '1';
const facilitatorUrl =
  process.env.SDK_API_KEY_E2E_FACILITATOR_URL ?? 'https://devnet.agentsmith.xyz/facilitator';

const initialize = (apiKey: string) =>
  createResourceServer({
    facilitator: { url: facilitatorUrl, apiKey },
    network: 'stellar:testnet',
  });

describe.runIf(enabled)('API key journey against the hosted testnet Facilitator', () => {
  it('creates, rotates and revokes a key that authenticates capability discovery', async () => {
    const keys = new ApiKeyManager({ facilitatorUrl });
    const domain = `sdk-e2e-${randomBytes(6).toString('hex')}.example.com`;

    const { apiKey: first } = await keys.createApiKey({
      name: 'SDK API key journey',
      domain,
      email: 'sdk-e2e@example.com',
    });
    await expect(initialize(first)).resolves.toBeDefined();

    await expect(
      keys.createApiKey({ name: 'Duplicate', domain, email: 'sdk-e2e@example.com' }),
    ).rejects.toMatchObject({ code: 'DOMAIN_TAKEN', status: 409 });

    const { apiKey: second } = await keys.rotateApiKey(first);
    expect(second).not.toBe(first);
    await expect(initialize(first)).resolves.toBeDefined();
    await expect(initialize(second)).resolves.toBeDefined();
    await expect(keys.rotateApiKey(first)).rejects.toMatchObject({ code: 'NOT_CURRENT_KEY' });

    await keys.revokeApiKey(second);
    await keys.revokeApiKey(first);
    await expect(initialize(second)).rejects.toBeInstanceOf(ResourceServerInitializationError);
    const refused = await keys.rotateApiKey(second).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiKeyRequestError);
    expect(refused).toMatchObject({ status: 401 });
  }, 60_000);
});
