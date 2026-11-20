const PAISE_PER_RUPEE = 100n;
const BASIS_POINTS_PER_WHOLE = 10_000n;

export function parseDecimalToMinor(value: string): bigint {
  const [whole, fraction, ...extra] = value.split(".");
  if (
    !/^[+-]?\d+$/.test(whole) ||
    (fraction !== undefined && !/^\d{1,2}$/.test(fraction)) ||
    extra.length > 0
  ) {
    throw new Error(`Invalid decimal money amount: ${value}`);
  }

  const negative = whole.startsWith("-");
  const magnitude =
    BigInt(whole.replace(/^[+-]/, "")) * PAISE_PER_RUPEE +
    BigInt((fraction ?? "").padEnd(2, "0"));
  return negative ? -magnitude : magnitude;
}

export function parseMinor(value: string): bigint {
  if (!/^[+-]?\d+$/.test(value)) {
    throw new Error(`Invalid integer minor-unit amount: ${value}`);
  }
  return BigInt(value);
}

export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("Rounding denominator must be positive");
  }
  const magnitude = numerator < 0n ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const rounded = quotient + (2n * remainder >= denominator ? 1n : 0n);
  return numerator < 0n ? -rounded : rounded;
}

export function percentageFee(grossMinor: bigint, rateBps: bigint): bigint {
  return roundHalfUp(grossMinor * rateBps, BASIS_POINTS_PER_WHOLE);
}
