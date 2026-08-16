/**
 * On-device text extraction — zero network calls, zero paid services.
 *
 * Supports:
 *   - text/plain, text/markdown, application/json  -> read as UTF-8
 *   - application/pdf                              -> parse content streams
 *   - .docx (OOXML)                                -> unzip word/document.xml
 *
 * PDF and DOCX both need DEFLATE, so a compact pure-JS raw-inflate is bundled
 * below rather than pulling a native dependency.
 */

import * as FileSystem from 'expo-file-system';

/* ------------------------------ base64 -> bytes --------------------------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let p = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_LOOKUP[clean.charCodeAt(i)];
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, p);
}

/* --------------------------------- inflate -------------------------------- */

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  counts: Int32Array;
  symbols: Int32Array;
}

function buildHuffman(lengths: Uint8Array): Huffman {
  const counts = new Int32Array(16);
  for (const len of lengths) counts[len]++;
  counts[0] = 0;
  const offsets = new Int32Array(16);
  for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
  const symbols = new Int32Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    if (lengths[sym]) symbols[offsets[lengths[sym]]++] = sym;
  }
  return { counts, symbols };
}

class BitReader {
  private pos = 0;
  private bitBuf = 0;
  private bitCount = 0;
  constructor(private readonly data: Uint8Array) {}

  bits(n: number): number {
    while (this.bitCount < n) {
      if (this.pos >= this.data.length) throw new Error('inflate: out of input');
      this.bitBuf |= this.data[this.pos++] << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCount -= n;
    return value;
  }

  alignToByte(): void {
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  readBytes(n: number): Uint8Array {
    const slice = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  decode(table: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = table.counts[len];
      if (code - first < count) return table.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: bad huffman code');
  }
}

const FIXED_LIT = (() => {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  return buildHuffman(lengths);
})();
const FIXED_DIST = buildHuffman(new Uint8Array(30).fill(5));

/** Raw DEFLATE (RFC 1951). */
export function inflateRaw(input: Uint8Array): Uint8Array {
  const reader = new BitReader(input);
  const chunks: number[] = [];
  const out: Uint8Array[] = [];
  let window: number[] = chunks;
  let final = false;

  while (!final) {
    final = reader.bits(1) === 1;
    const type = reader.bits(2);

    if (type === 0) {
      reader.alignToByte();
      const header = reader.readBytes(4);
      const len = header[0] | (header[1] << 8);
      const stored = reader.readBytes(len);
      for (let i = 0; i < stored.length; i++) window.push(stored[i]);
      continue;
    }

    let lit: Huffman;
    let dist: Huffman;

    if (type === 1) {
      lit = FIXED_LIT;
      dist = FIXED_DIST;
    } else if (type === 2) {
      const hlit = reader.bits(5) + 257;
      const hdist = reader.bits(5) + 1;
      const hclen = reader.bits(4) + 4;
      const clenLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clenLengths[CLEN_ORDER[i]] = reader.bits(3);
      const clenTable = buildHuffman(clenLengths);

      const lengths = new Uint8Array(hlit + hdist);
      let i = 0;
      while (i < lengths.length) {
        const sym = reader.decode(clenTable);
        if (sym < 16) lengths[i++] = sym;
        else if (sym === 16) {
          const prev = lengths[i - 1];
          let repeat = 3 + reader.bits(2);
          while (repeat--) lengths[i++] = prev;
        } else if (sym === 17) {
          let repeat = 3 + reader.bits(3);
          while (repeat--) lengths[i++] = 0;
        } else {
          let repeat = 11 + reader.bits(7);
          while (repeat--) lengths[i++] = 0;
        }
      }
      lit = buildHuffman(lengths.subarray(0, hlit));
      dist = buildHuffman(lengths.subarray(hlit));
    } else {
      throw new Error('inflate: reserved block type');
    }

    for (;;) {
      const sym = reader.decode(lit);
      if (sym === 256) break;
      if (sym < 256) {
        window.push(sym);
      } else {
        const li = sym - 257;
        const length = LENGTH_BASE[li] + reader.bits(LENGTH_EXTRA[li]);
        const ds = reader.decode(dist);
        const distance = DIST_BASE[ds] + reader.bits(DIST_EXTRA[ds]);
        const start = window.length - distance;
        if (start < 0) throw new Error('inflate: distance too far back');
        for (let i = 0; i < length; i++) window.push(window[start + i]);
      }
    }
  }

  out.push(Uint8Array.from(window));
  return out[0];
}

/** zlib wrapper (RFC 1950) — two-byte header, adler32 trailer. */
export function inflate(input: Uint8Array): Uint8Array {
  const looksZlib = (input[0] & 0x0f) === 8 && ((input[0] << 8) | input[1]) % 31 === 0;
  return inflateRaw(looksZlib ? input.subarray(2) : input);
}

/* ------------------------------- byte helpers ----------------------------- */

function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let s = '';
  for (let i = start; i < end; i += 8192) {
    s += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + 8192, end)))
    );
  }
  return s;
}

function utf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if ((b & 0xe0) === 0xc0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b & 0xf0) === 0xe0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      out += String.fromCodePoint(cp);
      i += 4;
    }
  }
  return out;
}

function indexOfBytes(haystack: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/* ---------------------------------- PDF ----------------------------------- */

/**
 * Walks every `stream ... endstream` block, inflating FlateDecode payloads,
 * then pulls the operands of the text-showing operators (Tj, TJ, ', ").
 * Good enough to feed an LLM; it is not a layout-faithful renderer.
 */
export function extractPdfText(bytes: Uint8Array): string {
  const STREAM = [0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // "stream"
  const ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d];
  const pieces: string[] = [];
  let cursor = 0;

  while (cursor < bytes.length) {
    const start = indexOfBytes(bytes, STREAM, cursor);
    if (start === -1) break;
    const end = indexOfBytes(bytes, ENDSTREAM, start);
    if (end === -1) break;

    // Skip the EOL that must follow the `stream` keyword.
    let dataStart = start + STREAM.length;
    if (bytes[dataStart] === 0x0d) dataStart++;
    if (bytes[dataStart] === 0x0a) dataStart++;

    const dictStart = Math.max(0, start - 900);
    const dict = latin1(bytes, dictStart, start);
    const raw = bytes.subarray(dataStart, end);

    let content = '';
    if (/\/Flate(Decode)?/.test(dict)) {
      try {
        content = latin1(inflate(raw));
      } catch {
        content = '';
      }
    } else if (!/\/(DCT|JPX|CCITT|JBIG2|RunLength|LZW)/.test(dict)) {
      content = latin1(raw);
    }

    if (content) pieces.push(decodeContentStream(content));
    cursor = end + ENDSTREAM.length;
  }

  return pieces
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeContentStream(content: string): string {
  const out: string[] = [];
  // Text operators: (literal) Tj | [(a) -3 (b)] TJ | (s) ' | (s) "
  const re = /(\[(?:[^\][\\]|\\.)*\]|\((?:[^()\\]|\\.)*\))\s*(TJ|Tj|'|")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const operand = m[1];
    const strings = operand.match(/\((?:[^()\\]|\\.)*\)/g) ?? [];
    const line = strings.map((s) => unescapePdfString(s.slice(1, -1))).join('');
    if (line.trim()) out.push(line);
  }
  // Td/TD/T* generally start a new visual line; approximate with newlines.
  return out.join('\n');
}

function unescapePdfString(s: string): string {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c) => {
      const map: Record<string, string> = {
        n: '\n',
        r: '\n',
        t: '\t',
        b: '',
        f: '\n',
        '(': '(',
        ')': ')',
        '\\': '\\',
      };
      return map[c] ?? c;
    })
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

/* ---------------------------------- DOCX ---------------------------------- */

/** Reads word/document.xml out of the OOXML zip and strips the markup. */
export function extractDocxText(bytes: Uint8Array): string {
  const target = 'word/document.xml';
  const LOCAL_SIG = [0x50, 0x4b, 0x03, 0x04];
  let cursor = 0;

  while (cursor < bytes.length) {
    const at = indexOfBytes(bytes, LOCAL_SIG, cursor);
    if (at === -1) break;

    const view = new DataView(bytes.buffer, bytes.byteOffset + at, Math.min(30, bytes.length - at));
    const method = view.getUint16(8, true);
    const compressedSize = view.getUint32(18, true);
    const nameLen = view.getUint16(26, true);
    const extraLen = view.getUint16(28, true);
    const nameStart = at + 30;
    const name = latin1(bytes, nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;

    if (name === target) {
      // Size 0 means a data descriptor follows; fall back to scanning ahead.
      const size =
        compressedSize > 0
          ? compressedSize
          : (indexOfBytes(bytes, LOCAL_SIG, dataStart) === -1
              ? bytes.length
              : indexOfBytes(bytes, LOCAL_SIG, dataStart)) - dataStart;
      const payload = bytes.subarray(dataStart, dataStart + size);
      const xmlBytes = method === 8 ? inflateRaw(payload) : payload;
      return xmlToText(utf8(xmlBytes));
    }

    cursor = compressedSize > 0 ? dataStart + compressedSize : dataStart + 1;
  }
  throw new Error('word/document.xml not found in archive');
}

function xmlToText(xml: string): string {
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* --------------------------------- facade --------------------------------- */

export interface ExtractionResult {
  text: string;
  ok: boolean;
  note?: string;
}

const MAX_EXTRACTED_CHARS = 40_000;

export async function extractTextFromFile(
  uri: string,
  mimeType: string,
  fileName: string
): Promise<ExtractionResult> {
  const lower = fileName.toLowerCase();
  const isPdf = mimeType.includes('pdf') || lower.endsWith('.pdf');
  const isDocx =
    mimeType.includes('officedocument.wordprocessingml') || lower.endsWith('.docx');
  const isPlain =
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    /\.(txt|md|markdown|json|csv|rtf)$/.test(lower);

  try {
    if (isPlain) {
      const text = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      return { text: text.slice(0, MAX_EXTRACTED_CHARS), ok: true };
    }

    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const bytes = base64ToBytes(b64);

    if (isPdf) {
      const text = extractPdfText(bytes);
      if (text.length < 40) {
        return {
          text,
          ok: false,
          note:
            'This PDF appears to be a scan or uses embedded font encodings we cannot map. ' +
            'Paste the text manually in the Vault notes so the agent can still use it.',
        };
      }
      return { text: text.slice(0, MAX_EXTRACTED_CHARS), ok: true };
    }

    if (isDocx) {
      const text = extractDocxText(bytes);
      return { text: text.slice(0, MAX_EXTRACTED_CHARS), ok: text.length > 20 };
    }

    return {
      text: '',
      ok: false,
      note: `Unsupported file type (${mimeType || 'unknown'}). Supported: PDF, DOCX, TXT, MD.`,
    };
  } catch (err) {
    return {
      text: '',
      ok: false,
      note: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
