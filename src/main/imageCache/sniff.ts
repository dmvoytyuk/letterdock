// Magic-byte detection for cached remote images. We never trust the server's Content-Type.

export type ImageMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif'
  | 'image/bmp'
  | 'image/x-icon'
  | 'image/svg+xml';

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

export function sniffImage(b: Uint8Array): ImageMime | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61)
    return 'image/gif';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp';
  if (startsWith(b, [0x42, 0x4d]) && b.length > 14) return 'image/bmp';
  if (startsWith(b, [0x00, 0x00, 0x01, 0x00]) && b.length > 6) return 'image/x-icon';
  if (startsWith(b, [0x66, 0x74, 0x79, 0x70], 4)) {
    // ISO base media file: avif / avis brands
    const brand = String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  // SVG: text that contains an <svg root after optional BOM, xml declaration, comments, doctype.
  const head = new TextDecoder('utf-8').decode(b.subarray(0, 2048)); // also drops a BOM
  if (/^\s*(<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head))
    return 'image/svg+xml';
  return null;
}
