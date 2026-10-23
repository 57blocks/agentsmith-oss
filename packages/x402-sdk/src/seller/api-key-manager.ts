import {
  createAuthorizationHeaders,
  parseFacilitatorUrl,
  validateFacilitatorTimeout,
} from './facilitator-url.js';

export interface ApiKeyManagerConfig {
  /** Facilitator base URL; must use HTTP(S) without credentials, query or fragment. */
  facilitatorUrl: string;
  /** Timeout per request in milliseconds; defaults to 15,000. */
  timeoutMs?: number;
}

/** Resource Server details; the Facilitator validates and normalizes them. */
export interface ApiKeyRegistration {
  name: string;
  /** Bare host name, unique per Resource Server. */
  domain: string;
  /** Contact address; stored, never verified or returned. */
  email: string;
}

export type ApiKeyOperation = 'create' | 'rotate' | 'revoke';

/** The Facilitator answered and refused the request; nothing changed. */
export class ApiKeyRequestError extends Error {
  readonly operation: ApiKeyOperation;
  readonly status: number;
  /** Facilitator error code, such as DOMAIN_TAKEN, RATE_LIMITED or NOT_CURRENT_KEY. */
  readonly code?: string;
  /** Seconds to wait before retrying, on a rate-limited request. */
  readonly retryAfterSeconds?: number;

  constructor(operation: ApiKeyOperation, status: number, code?: string, retryAfter?: number) {
    super(
      `Facilitator refused the ${operation} API key request with ${status}${code ? ` ${code}` : ''}`,
    );
    this.name = 'ApiKeyRequestError';
    this.operation = operation;
    this.status = status;
    if (code !== undefined) this.code = code;
    if (retryAfter !== undefined) this.retryAfterSeconds = retryAfter;
  }
}

/**
 * No usable answer arrived, so the request may have taken effect. Do not resend it: a created
 * or rotated key cannot be fetched again, and a resend is refused. Ask an operator for a new key.
 */
export class ApiKeyOutcomeUnknownError extends Error {
  readonly operation: ApiKeyOperation;

  constructor(operation: ApiKeyOperation) {
    super(`The outcome of the ${operation} API key request is unknown; do not resend it`);
    this.name = 'ApiKeyOutcomeUnknownError';
    this.operation = operation;
  }
}

interface KeyRequest {
  operation: ApiKeyOperation;
  method: 'POST' | 'DELETE';
  path: string;
  headers: Record<string, string>;
  body?: string;
  successStatus: number;
}

/**
 * Obtains, rotates and revokes the Resource Server's Facilitator API key. Works before the
 * Seller has a key; constructing it sends nothing. Keys are returned to the caller only: they
 * are never logged, stored or placed in an error. Requests are never retried.
 */
export class ApiKeyManager {
  readonly #url: string;
  readonly #timeoutMs: number;

  constructor(config: ApiKeyManagerConfig) {
    this.#url = parseFacilitatorUrl(config.facilitatorUrl);
    this.#timeoutMs = config.timeoutMs ?? 15_000;
    validateFacilitatorTimeout(this.#timeoutMs);
  }

  /** Registers the Resource Server and returns its first key, shown only this once. */
  async createApiKey(registration: ApiKeyRegistration): Promise<{ apiKey: string }> {
    const { name, domain, email } = registration;
    if (![name, domain, email].every((field) => typeof field === 'string')) {
      throw new TypeError('Registration name, domain and email must be strings');
    }
    const body = await this.#send({
      operation: 'create',
      method: 'POST',
      path: '/credentials/register',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, domain, email }),
      successStatus: 201,
    });
    return { apiKey: issuedKey('create', body) };
  }

  /** Returns a new key; the presented key keeps working for ten more minutes. */
  async rotateApiKey(apiKey: string): Promise<{ apiKey: string }> {
    const body = await this.#send({
      operation: 'rotate',
      method: 'POST',
      path: '/credentials/keys/rotate',
      headers: createAuthorizationHeaders(apiKey),
      successStatus: 201,
    });
    return { apiKey: issuedKey('rotate', body) };
  }

  /** Revokes the presented key at once. Revoking the only key needs an operator to recover. */
  async revokeApiKey(apiKey: string): Promise<void> {
    await this.#send({
      operation: 'revoke',
      method: 'DELETE',
      path: '/credentials/keys/current',
      headers: createAuthorizationHeaders(apiKey),
      successStatus: 204,
    });
  }

  /** Sends one request; resolves to the parsed success body, or throws a typed error. */
  async #send(request: KeyRequest): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.#url}${request.path}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // Timeouts and network errors: the request may have reached the Facilitator.
      throw new ApiKeyOutcomeUnknownError(request.operation);
    }
    const body = await readJson(response);
    if (response.status === request.successStatus) return body;
    const code = errorCode(body);
    // A 5xx that is not the Facilitator's own answer (a gateway error) may follow a done request.
    if (code === undefined && response.status >= 500) {
      throw new ApiKeyOutcomeUnknownError(request.operation);
    }
    throw new ApiKeyRequestError(
      request.operation,
      response.status,
      code,
      response.status === 429 ? retryAfterSeconds(response) : undefined,
    );
  }
}

/** The key in a success body; a success without one leaves the outcome unknown. */
function issuedKey(operation: ApiKeyOperation, body: unknown): string {
  const apiKey = isRecord(body) ? body.apiKey : undefined;
  if (typeof apiKey === 'string' && apiKey) return apiKey;
  throw new ApiKeyOutcomeUnknownError(operation);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The `{ error: { code } }` code, kept only when it looks like a code and not free text. */
function errorCode(body: unknown): string | undefined {
  const error = isRecord(body) ? body.error : undefined;
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get('Retry-After');
  const value = header === null ? NaN : Number(header);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}
