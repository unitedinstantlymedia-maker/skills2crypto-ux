/**
 * Tact-compatible CRC-32 used to derive default message opcodes when the
 * .tact source omits an explicit `message(0xNNNNNNNN)`. Tact's compiler
 * applies the same algorithm: crc32("MessageName") as a 32-bit unsigned int.
 */
const TABLE: number[] = (() => {
  const t = new Array<number>(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(s: string): number {
  let crc = 0xffffffff;
  const buf = Buffer.from(s, "utf8");
  for (let i = 0; i < buf.length; i++) {
    crc = TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
