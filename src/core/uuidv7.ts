/**
 * UUIDv7 generator (RFC 9562) without external dependencies.
 *
 * Layout:
 *   - 48-bit Unix timestamp in milliseconds (big-endian)
 *   - 4-bit version (0111)
 *   - 12 random bits
 *   - 2-bit variant (10)
 *   - 62 random bits
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16)
  const now = Date.now()
  const timestamp = BigInt(now)

  // Fill timestamp (bytes 0-5)
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number((timestamp >> BigInt((5 - i) * 8)) & 0xffn)
  }

  // Fill remaining bytes with cryptographically secure random values
  globalThis.crypto.getRandomValues(bytes.subarray(6))

  // Set version (0111) in the high nibble of byte 6
  bytes[6] = (bytes[6] & 0x0f) | 0x70

  // Set variant (10) in the high bits of byte 8
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  // Convert to hex string with dashes
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
