import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAwsKmsClient } from '../src/modules/channels/kms/aws-kms-client.js';

afterEach(() => vi.restoreAllMocks());

describe('AWS KMS client adapter', () => {
  it('signs raw bytes with pure Ed25519 by key ARN', async () => {
    const send = vi
      .spyOn(KMSClient.prototype, 'send')
      .mockResolvedValue({ Signature: new Uint8Array(64) } as never);
    await createAwsKmsClient('us-west-1').sign('arn:key/1', new Uint8Array([1, 2, 3]));
    const command = send.mock.calls[0]![0] as SignCommand;
    expect(command).toBeInstanceOf(SignCommand);
    expect(command.input).toEqual({
      KeyId: 'arn:key/1',
      Message: new Uint8Array([1, 2, 3]),
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512',
    });
  });

  it('returns the key ARN, spec and usage from GetPublicKey', async () => {
    const send = vi.spyOn(KMSClient.prototype, 'send').mockResolvedValue({
      KeyId: 'arn:key/1',
      KeySpec: 'ECC_NIST_EDWARDS25519',
      KeyUsage: 'SIGN_VERIFY',
      PublicKey: new Uint8Array(44),
    } as never);
    const key = await createAwsKmsClient('us-west-1').getPublicKey('alias/x402/GABC');
    expect(send.mock.calls[0]![0]).toBeInstanceOf(GetPublicKeyCommand);
    expect(key).toEqual({
      keyArn: 'arn:key/1',
      keySpec: 'ECC_NIST_EDWARDS25519',
      keyUsage: 'SIGN_VERIFY',
      publicKey: new Uint8Array(44),
    });
  });

  it('fails when KMS returns no signature', async () => {
    vi.spyOn(KMSClient.prototype, 'send').mockResolvedValue({} as never);
    await expect(
      createAwsKmsClient('us-west-1').sign('arn:key/1', new Uint8Array(1)),
    ).rejects.toThrow(/no signature/);
  });

  it('sends the alias as KeyId on GetPublicKey', async () => {
    const send = vi.spyOn(KMSClient.prototype, 'send').mockResolvedValue({
      KeyId: 'arn:key/1',
      PublicKey: new Uint8Array(44),
    } as never);
    await createAwsKmsClient('us-west-1').getPublicKey('alias/x402/GABC');
    expect((send.mock.calls[0]![0] as GetPublicKeyCommand).input).toEqual({
      KeyId: 'alias/x402/GABC',
    });
  });

  it.each([
    ['KeyId', { PublicKey: new Uint8Array(44) }],
    ['PublicKey', { KeyId: 'arn:key/1' }],
  ])('throws when GetPublicKey omits %s', async (_field, response) => {
    vi.spyOn(KMSClient.prototype, 'send').mockResolvedValue(response as never);
    await expect(createAwsKmsClient('us-west-1').getPublicKey('alias/x402/GABC')).rejects.toThrow(
      /no public key for alias\/x402\/GABC/,
    );
  });

  it('propagates SDK errors unchanged', async () => {
    const failure = new Error('AccessDenied');
    vi.spyOn(KMSClient.prototype, 'send').mockRejectedValue(failure);
    const client = createAwsKmsClient('us-west-1');
    await expect(client.sign('arn:key/1', new Uint8Array(1))).rejects.toBe(failure);
    await expect(client.getPublicKey('alias/x402/GABC')).rejects.toBe(failure);
  });

  it('configures region, retry cap and request timeouts', async () => {
    const instances: KMSClient[] = [];
    const impl = function (this: KMSClient) {
      instances.push(this);
      return Promise.resolve({ Signature: new Uint8Array(64) });
    };
    vi.spyOn(KMSClient.prototype, 'send').mockImplementation(impl as never);
    await createAwsKmsClient('us-west-1').sign('arn:key/1', new Uint8Array(1));
    expect(await instances[0]!.config.region()).toBe('us-west-1');
    expect(await instances[0]!.config.maxAttempts()).toBe(3);
    const handler = (await instances[0]!.config.requestHandler) as unknown as {
      configProvider: Promise<Record<string, unknown>>;
    };
    expect(await handler.configProvider).toMatchObject({
      connectionTimeout: 3_000,
      requestTimeout: 5_000,
      socketTimeout: 5_000,
      throwOnRequestTimeout: true,
    });
  });
});
