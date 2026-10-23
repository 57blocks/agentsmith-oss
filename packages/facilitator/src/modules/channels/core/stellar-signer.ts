import { Keypair, StrKey } from '@stellar/stellar-sdk';
import {
  basicNodeSigner,
  type SignAuthEntry,
  type SignTransaction,
} from '@stellar/stellar-sdk/contract';

/** Same shape as upstream `FacilitatorStellarSigner`, so env and KMS signers both satisfy it. */
export interface StellarSigner {
  readonly address: string;
  signTransaction: SignTransaction;
  signAuthEntry: SignAuthEntry;
}

/** `ok: false` means the account is wrong for this deployment; `reason` goes to the log. */
export type SignerLoad = { ok: true; signer: StellarSigner } | { ok: false; reason: string };

export interface SignerProvider {
  /** Where keys live (`env`, `kms`), for logs. */
  readonly mode: string;
  /**
   * Creates and checks the signer for one channel address. Throws only when the key store cannot be
   * reached (throttling, a timeout, an outage); a wrong account is `ok: false`.
   */
  load(address: string): Promise<SignerLoad>;
}

/**
 * Environment keys: maps each secret to the address it derives, so a secret and its address can
 * never be mis-paired.
 */
export class EnvSignerProvider implements SignerProvider {
  readonly mode = 'env';
  private readonly keypairs: ReadonlyMap<string, Keypair>;

  constructor(
    secrets: readonly string[],
    private readonly networkPassphrase: string,
  ) {
    this.keypairs = new Map(
      secrets.map((secret) => {
        const keypair = Keypair.fromSecret(secret);
        return [keypair.publicKey(), keypair];
      }),
    );
  }

  /** The addresses of the configured secrets: the list that seeds an empty pool. */
  addresses(): string[] {
    return [...this.keypairs.keys()];
  }

  async load(address: string): Promise<SignerLoad> {
    const keypair = this.keypairs.get(address);
    if (!keypair) return { ok: false, reason: 'no configured secret derives this address' };
    return { ok: true, signer: { address, ...basicNodeSigner(keypair, this.networkPassphrase) } };
  }
}

/**
 * Creates and checks a signer on first sight and reuses it. Only a successful load is cached;
 * a failure is neither cached nor retried on a timer. Entries are never evicted: a removed member is
 * never leased, so its signer is simply unused.
 */
export function withSignerCache(inner: SignerProvider): SignerProvider {
  const cache = new Map<string, StellarSigner>();
  return {
    mode: inner.mode,
    async load(address) {
      const cached = cache.get(address);
      if (cached) return { ok: true, signer: cached };
      if (!StrKey.isValidEd25519PublicKey(address)) {
        return { ok: false, reason: 'not a Stellar G address' };
      }
      const loaded = await inner.load(address);
      if (loaded.ok) cache.set(address, loaded.signer);
      return loaded;
    },
  };
}
