/**
 * Runtime discovery of usable Gemini models.
 *
 * Google retires model aliases fairly aggressively — `gemini-2.5-flash-lite`
 * and `gemini-2.0-flash-lite` both started returning 404 "no longer available"
 * with no code change on our side. Asking ListModels which models this key can
 * actually call is the only version of this that keeps working.
 */

import { createLogger } from './logger';
import { readJson, writeJson } from './storage';

const log = createLogger('gemini');

const CACHE_KEY = 'aiba.gemini.models.v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WANTED = 3;

/** Only used when ListModels is unreachable and nothing is cached. */
const STATIC_FALLBACK = ['gemini-flash-latest', 'gemini-2.5-flash'];

/** Not chat models, or not useful for driving the agent loop. */
const EXCLUDE = /embedding|aqa|imagen|veo|tts|audio|image-generation|learnlm|gemma/i;

interface ModelEntry {
  name: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
}

interface Cached {
  models: string[];
  fetchedAt: number;
}

/**
 * Cheapest-capable first: the agent makes one call per step, so a lite model
 * stretches the free tier furthest. Falls back to flash, then pro.
 */
function tierScore(id: string): number {
  if (/flash-lite/.test(id)) return 4;
  if (/flash/.test(id)) return 3;
  if (/pro/.test(id)) return 2;
  return 1;
}

/** Prefer newer generations: gemini-3.0-flash beats gemini-2.5-flash. */
function versionScore(id: string): number {
  const match = /(\d+)\.(\d+)/.exec(id);
  if (!match) return /latest/.test(id) ? 99 : 0;
  return Number(match[1]) * 10 + Number(match[2]);
}

async function fetchCatalogue(key: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': key },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ListModels HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const json: { models?: ModelEntry[] } = await res.json();
    const usable = (json.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((id) => !EXCLUDE.test(id))
      .sort((a, b) => tierScore(b) - tierScore(a) || versionScore(b) - versionScore(a));

    if (!usable.length) throw new Error('no models support generateContent for this key');
    return usable.slice(0, WANTED);
  } finally {
    clearTimeout(timer);
  }
}

/** Model ids to try, best first. Never throws — degrades to cache or statics. */
export async function getGeminiModels(key: string): Promise<string[]> {
  const cached = await readJson<Cached | null>(CACHE_KEY, null);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.models.length) {
    return cached.models;
  }

  try {
    const models = await fetchCatalogue(key);
    await writeJson(CACHE_KEY, { models, fetchedAt: Date.now() } satisfies Cached);
    log.info(`discovered ${models.length} models: ${models.join(', ')}`);
    return models;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (cached?.models.length) {
      log.warn(`discovery failed (${reason}), using stale cache`);
      return cached.models;
    }
    log.warn(`discovery failed (${reason}), using static fallback`);
    return STATIC_FALLBACK;
  }
}

export async function clearGeminiModelCache(): Promise<void> {
  await writeJson(CACHE_KEY, { models: [], fetchedAt: 0 } satisfies Cached);
}
