const MAX_TOKEN_AMOUNT = (1n << 127n) - 1n;

/** Whether an atomic token amount fits the positive signed i128 SEP-41 range. */
export function isPositiveI128(amount: string): boolean {
  return (
    typeof amount === 'string' && /^[1-9]\d*$/.test(amount) && BigInt(amount) <= MAX_TOKEN_AMOUNT
  );
}

/** Whether an atomic token amount is zero or fits the positive signed i128 SEP-41 range. */
export function isNonNegativeI128(amount: string): boolean {
  return amount === '0' || isPositiveI128(amount);
}
