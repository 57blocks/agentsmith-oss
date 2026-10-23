import type { Request } from 'express';

/** Who made an x402 request: the Resource Server its key belongs to, or the anonymous one. */
export interface Caller {
  resourceServerId: string;
  /** The key used; absent for an anonymous testnet request. */
  credentialId?: string;
}

/** The request after `CallerGuard` has attributed it. */
export type AttributedRequest = Request & { caller: Caller };
