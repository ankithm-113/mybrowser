/**
 * Persistence layer.
 *
 * API keys live in expo-secure-store (hardware-backed keystore / keychain).
 * Everything else lives in AsyncStorage, encrypted at rest with a random
 * 256-bit key that is itself held in SecureStore.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const MASTER_KEY_SLOT = 'aiba.master.key.v1';

export const KEYS = {
  vault: 'aiba.vault.v1',
  settings: 'aiba.settings.v1',
  jobs: 'aiba.jobs.v1',
  runs: 'aiba.runs.v1',
  health: 'aiba.provider.health.v1',
} as const;

const SECRET_SLOTS = {
  geminiKey: 'aiba.key.gemini',
  groqKey: 'aiba.key.groq',
  openrouterKey: 'aiba.key.openrouter',
} as const;

export type SecretName = keyof typeof SECRET_SLOTS;

/* --------------------------- master key handling -------------------------- */

let cachedMasterKey: string | null = null;

async function getMasterKey(): Promise<string> {
  if (cachedMasterKey) return cachedMasterKey;
  let key = await SecureStore.getItemAsync(MASTER_KEY_SLOT).catch(() => null);
  if (!key) {
    const bytes = await Crypto.getRandomBytesAsync(32);
    key = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    await SecureStore.setItemAsync(MASTER_KEY_SLOT, key);
  }
  cachedMasterKey = key;
  return key;
}

/**
 * Keystream cipher: SHA-256(masterKey || blockIndex) produces 32 bytes of
 * keystream per block, XORed against the UTF-8 payload. The master key never
 * leaves SecureStore, so an AsyncStorage dump alone is not readable.
 */
async function keystream(masterKey: string, byteLength: number): Promise<Uint8Array> {
  const out = new Uint8Array(byteLength);
  let written = 0;
  let block = 0;
  while (written < byteLength) {
    const digest = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      `${masterKey}:${block}`,
      { encoding: Crypto.CryptoEncoding.HEX }
    );
    for (let i = 0; i < digest.length && written < byteLength; i += 2) {
      out[written++] = parseInt(digest.slice(i, i + 2), 16);
    }
    block++;
  }
  return out;
}

function utf8Encode(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of s) {
    let cp = ch.codePointAt(0)!;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
  }
  return new Uint8Array(bytes);
}

function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp: number;
    let len: number;
    if (b < 0x80) [cp, len] = [b, 1];
    else if ((b & 0xe0) === 0xc0) [cp, len] = [b & 0x1f, 2];
    else if ((b & 0xf0) === 0xe0) [cp, len] = [b & 0x0f, 3];
    else [cp, len] = [b & 0x07, 4];
    for (let j = 1; j < len; j++) cp = (cp << 6) | (bytes[i + j] & 0x3f);
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 63];
  }
  return out;
}

function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

const ENVELOPE_PREFIX = 'enc1:';

async function encrypt(plain: string): Promise<string> {
  const key = await getMasterKey();
  const data = utf8Encode(plain);
  const stream = await keystream(key, data.length);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ stream[i];
  return ENVELOPE_PREFIX + toBase64(out);
}

async function decrypt(payload: string): Promise<string> {
  if (!payload.startsWith(ENVELOPE_PREFIX)) return payload; // legacy plaintext
  const key = await getMasterKey();
  const data = fromBase64(payload.slice(ENVELOPE_PREFIX.length));
  const stream = await keystream(key, data.length);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ stream[i];
  return utf8Decode(out);
}

/* ------------------------------- public API ------------------------------- */

export async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(await decrypt(raw)) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, await encrypt(JSON.stringify(value)));
}

export async function removeKey(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
}

/** API keys: SecureStore first, falling back to the EXPO_PUBLIC_* build env. */
export async function getSecret(name: SecretName): Promise<string> {
  const stored = await SecureStore.getItemAsync(SECRET_SLOTS[name]).catch(() => null);
  if (stored) return stored;
  const fromEnv: Record<SecretName, string | undefined> = {
    geminiKey: process.env.EXPO_PUBLIC_GEMINI_API_KEY,
    groqKey: process.env.EXPO_PUBLIC_GROQ_API_KEY,
    openrouterKey: process.env.EXPO_PUBLIC_OPENROUTER_API_KEY,
  };
  return fromEnv[name] ?? '';
}

export async function setSecret(name: SecretName, value: string): Promise<void> {
  if (value) await SecureStore.setItemAsync(SECRET_SLOTS[name], value);
  else await SecureStore.deleteItemAsync(SECRET_SLOTS[name]).catch(() => undefined);
}

export function newId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
