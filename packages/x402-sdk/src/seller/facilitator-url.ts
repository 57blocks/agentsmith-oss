/** Normalizes a Facilitator base URL; rejects credentials, query and fragment. */
export function parseFacilitatorUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Invalid Facilitator URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('Facilitator URL must be HTTP(S) without credentials, query or fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

export function validateFacilitatorTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError('Invalid Facilitator timeout');
  }
}

/** Bearer header for a Facilitator API key; the error never contains the key. */
export function createAuthorizationHeaders(apiKey: string | undefined): Record<string, string> {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new TypeError('A valid Facilitator API key is required');
  }
  try {
    const headers = new Headers({ Authorization: `Bearer ${apiKey}` });
    return { Authorization: headers.get('Authorization')! };
  } catch {
    throw new TypeError('A valid Facilitator API key is required');
  }
}
