import {
  FacilitatorResponseError,
  FacilitatorTimeoutError,
  HTTPFacilitatorClient,
} from '@x402/core/server';
import { SettleError, VerifyError } from '@x402/core/types';

/** Keeps raw transport errors out of native framework logs and HTTP responses. */
export class SafeHTTPFacilitatorClient extends HTTPFacilitatorClient {
  override async getSupported() {
    try {
      return await super.getSupported();
    } catch (error) {
      throw safeFacilitatorFailure(error, 'supported');
    }
  }

  override async verify(...args: Parameters<HTTPFacilitatorClient['verify']>) {
    try {
      return await super.verify(...args);
    } catch (error) {
      throw safeFacilitatorFailure(error, 'verify');
    }
  }

  override async settle(...args: Parameters<HTTPFacilitatorClient['settle']>) {
    try {
      return await super.settle(...args);
    } catch (error) {
      throw safeFacilitatorFailure(error, 'settle');
    }
  }
}

type FacilitatorOperation = 'supported' | 'verify' | 'settle';

const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const MAX_CAUSE_DEPTH = 8;

class SafeFacilitatorResponseError extends FacilitatorResponseError {
  declare readonly code?: string;

  constructor(
    readonly operation: FacilitatorOperation,
    code?: string,
  ) {
    super(`Facilitator ${operation} request failed`);
    if (code !== undefined) this.code = code;
  }
}

/** Reconstructs transport diagnostics without retaining arbitrary messages, stacks or causes. */
export function safeFacilitatorFailure(error: unknown, operation: FacilitatorOperation): Error {
  // Native x402 owns wire parsing; its typed errors do not retain the original failure flag.
  if (operation !== 'supported' && (error instanceof VerifyError || error instanceof SettleError)) {
    return error;
  }
  // Bound traversal so nested or cyclic fetch causes cannot prevent error handling.
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (
      current instanceof FacilitatorTimeoutError &&
      Number.isInteger(current.timeoutMs) &&
      current.timeoutMs > 0 &&
      current.timeoutMs <= 2_147_483_647
    ) {
      return new FacilitatorTimeoutError(operation, current.timeoutMs);
    }
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      NETWORK_ERROR_CODES.has(current.code)
    ) {
      return new SafeFacilitatorResponseError(operation, current.code);
    }
    current = current.cause;
  }
  return new SafeFacilitatorResponseError(operation);
}
