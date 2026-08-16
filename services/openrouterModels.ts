/**
 * Runtime discovery of OpenRouter's free models.
 *
 * Hardcoded `:free` slugs rot — OpenRouter regularly moves models to paid, at
 * which point the slug 404s and the whole fallback tier dies silently. Instead
 * we ask the catalogue which models are actually free right now, cache the
 * answer for a day, and keep a static list only as a last resort.
 */

import { createLogger } from './logger';
import { readJson, writeJson } from './storage';

const log = createLogger('openrouter');

const CACHE_KEY = 'aiba.openrouter.freeModels.v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WANTED = 4;

/** Used only when the catalogue cannot be reached and nothing is cached. */
const STATIC_FALLBACK = [
  'openrouter/free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-nano-9b-v2:free',
];

/**
 * Models that are free and text-capable but a poor fit for driving an agent:
 * audio/music generation, safety classifiers, and code-only endpoints.
 */
const EXCLUDE = /lyria|content-safety|whisper|tts|embed|rerank|guard|moderation/i;

interface CatalogueEntry {
  id: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

interface Cached {
  models: string[];
  fetchedAt: number;
}

function isFreeTextModel(m: CatalogueEntry): boolean {
  const prompt = parseFloat(m.pricing?.prompt ?? '1');
  const completion = parseFloat(m.pricing?.completion ?? '1');
  if (!(prompt === 0 && completion === 0)) return false;

  const input = m.architecture?.input_modalities ?? [];
  const output = m.architecture?.output_modalities ?? [];
  if (!input.includes('text') || !output.includes('text')) return false;

  return !EXCLUDE.test(m.id);
}

async function fetchCatalogue(key: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`catalogue HTTP ${res.status}`);

    const json: { data?: CatalogueEntry[] } = await res.json();
    const free = (json.data ?? [])
      .filter(isFreeTextModel)
      // Bigger context first: agent prompts carry a page snapshot plus the vault.
      .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))
      .map((m) => m.id);

    if (!free.length) throw new Error('catalogue returned no free text models');
    return free.slice(0, WANTED);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Free model ids to try, best first. Never throws — a discovery failure falls
 * back to the cache, then to the static list, so the tier keeps working.
 */
export async function getFreeModels(key: string): Promise<string[]> {
  const cached = await readJson<Cached | null>(CACHE_KEY, null);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.models.length) {
    return cached.models;
  }

  try {
    const models = await fetchCatalogue(key);
    await writeJson(CACHE_KEY, { models, fetchedAt: Date.now() } satisfies Cached);
    log.info(`discovered ${models.length} free models: ${models.join(', ')}`);
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

/** Forces the next call to re-query the catalogue. */
export async function clearFreeModelCache(): Promise<void> {
  await writeJson(CACHE_KEY, { models: [], fetchedAt: 0 } satisfies Cached);
}
