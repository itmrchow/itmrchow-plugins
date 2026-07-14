/**
 * Request-body accumulation for the internal-inject channel server.
 *
 * Exists as its own module for one reason: the naive `raw += chunk` decodes EVERY
 * chunk on its own, and a multi-byte character split across a TCP chunk boundary
 * then decodes as two halves — each becoming U+FFFD. The alert text this channel
 * carries is Chinese (3 bytes per character), so the corruption is not exotic: a
 * 60 KB alert reliably loses characters, the caller still gets a 200, and nobody
 * finds out. Bytes are therefore buffered and decoded ONCE, after the last chunk.
 *
 * The size cap is counted in BYTES for the same reason: `raw.length` on a decoded
 * string counts UTF-16 code units, which for Chinese text is roughly a third of
 * the byte count — a "64 KiB" cap that actually admits ~190 KB.
 */

/** Cap on the request body — the caller is a local service, not the open internet. */
export const MAX_BODY_BYTES = 64 * 1024

/** Accumulates request chunks and decodes them as one buffer at the end. */
export type BodyCollector = {
  /**
   * Add one chunk.
   *
   * @param chunk - Raw bytes from the request stream.
   * @returns false once the accumulated body exceeds the cap; the caller should
   *   then answer 413 and destroy the request.
   */
  push(chunk: Buffer): boolean
  /** Total bytes accumulated so far. */
  size(): number
  /** Decode everything accumulated as UTF-8. Call once, after the last chunk. */
  decode(): string
}

/**
 * Create a body collector that buffers bytes and decodes them only when complete.
 *
 * @param maxBytes - Byte cap; push() reports the overflow rather than throwing.
 * @returns A collector.
 */
export function createBodyCollector(maxBytes: number = MAX_BODY_BYTES): BodyCollector {
  const chunks: Buffer[] = []
  let size = 0

  return {
    push(chunk: Buffer): boolean {
      // Buffer.length is a byte count — unlike a decoded string's .length, which
      // counts UTF-16 code units and would undercount every non-ASCII character.
      size += chunk.length
      if (size > maxBytes) return false
      chunks.push(chunk)
      return true
    },
    size(): number {
      return size
    },
    decode(): string {
      // ONE decode over the concatenated bytes: a character straddling a chunk
      // boundary is only whole here, never in the individual chunks.
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}
