import crypto from 'crypto';

// Falls back to JWT_SECRET if a dedicated QR_SECRET isn't set, so this
// works immediately without a new env var — but setting a separate
// QR_SECRET is recommended so rotating one doesn't invalidate every
// QR sticker already printed and stuck on a van.
const QR_SECRET = process.env.QR_SECRET || process.env.JWT_SECRET;

if (!QR_SECRET) {
  throw new Error('QR_SECRET or JWT_SECRET must be set to sign van QR tokens.');
}

/**
 * Builds a signed, copy-pasteable token identifying a van.
 * Format: "<vanId>.<hmac>" — safe to paste directly into any QR generator.
 * This is permanent for the van's lifetime — no tripId embedded, since
 * trips change constantly but the printed sticker can't.
 */
export function signVanQrToken(vanId) {
  const hmac = crypto.createHmac('sha256', QR_SECRET).update(String(vanId)).digest('hex');
  return `${vanId}.${hmac}`;
}

/**
 * Verifies a scanned QR token and returns the vanId if valid, or null
 * if malformed or tampered with (wrong signature).
 */
export function verifyVanQrToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const lastDot = token.lastIndexOf('.');
  const vanId = token.slice(0, lastDot);
  const providedHmac = token.slice(lastDot + 1);
  if (!vanId || !providedHmac) return null;

  const expectedHmac = crypto.createHmac('sha256', QR_SECRET).update(vanId).digest('hex');

  const expectedBuf = Buffer.from(expectedHmac, 'hex');
  const providedBuf = Buffer.from(providedHmac, 'hex');
  if (expectedBuf.length !== providedBuf.length) return null;

  // Constant-time comparison to avoid leaking signature bytes via timing.
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) return null;

  return vanId;
}