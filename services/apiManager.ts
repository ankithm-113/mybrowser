/**
 * Multi-API stacking router.
 *
 * Chain: Gemini 2.5 Flash-Lite -> Groq (Llama 3.3 70B) -> OpenRouter (free tier).
 *
 * A 429 or 5xx never breaks the agentic loop: the provider is put on a cooldown
 * (honouring Retry-After when present) and the call falls through to the next
 * provider in the chain. Only when every provider is exhausted do we throw.
 */

import { LLMMessage, LLMResult, ProviderHealth, ProviderId } from '@/types';
import { KEYS, readJson, writeJson } from './storage';
import { loadSettings } from './settings';

interface ProviderSpec {
  id: ProviderId;
  label: string;
  models: string[];
  keyField: 'geminiKey' | 'groqKey' | 'openrouterKey';
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: 'gemini',
    label: 'Gemini 2.5 Flash-Lite',
    models: ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite'],
    keyField: 'geminiKey',
  },
  {
    id: 'groq',
    label: 'Groq Llama 3.3 70B',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    keyField: 'groqKey',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free)',
    models: [
      'deepseek/deepseek-chat-v3.1:free',
      'qwen/qwen3-235b-a22b:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ],
    keyField: 'openrouterKey',
  },
];

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

let health: Record<ProviderId, ProviderHealth> | null = null;

async function getHealth(): Promise<Record<ProviderId, ProviderHealth>> {
  if (health) return health;
  const blank = Object.fromEntries(
    PROVIDERS.map((p) => [
      p.id,
      { id: p.id, available: true, cooldownUntil: 0, successes: 0, failures: 0 },
    ])
  ) as Record<ProviderId, ProviderHealth>;
  health = await readJson(KEYS.health, blank);
  // Reconcile with the current provider list in case the chain changed.
  for (const p of PROVIDERS) if (!health[p.id]) health[p.id] = blank[p.id];
  return health;
}

async function persistHealth(): Promise<void> {
  if (health) await writeJson(KEYS.health, health);
}

export async function getProviderHealth(): Promise<ProviderHealth[]> {
  const h = await getHealth();
  return PROVIDERS.map((p) => h[p.id]);
}

export async function clearCooldowns(): Promise<void> {
  const h = await getHealth();
  for (const id of Object.keys(h) as ProviderId[]) {
    h[id].cooldownUntil = 0;
    h[id].available = true;
  }
  await persistHealth();
}

async function markFailure(id: ProviderId, error: string, retryAfterMs?: number): Promise<void> {
  const h = await getHealth();
  const entry = h[id];
  entry.failures += 1;
  entry.lastError = error;
  const backoff = Math.min(
    MAX_COOLDOWN_MS,
    retryAfterMs ?? DEFAULT_COOLDOWN_MS * Math.min(8, entry.failures)
  );
  entry.cooldownUntil = Date.now() + backoff;
  entry.available = false;
  await persistHealth();
}

async function markSuccess(id: ProviderId): Promise<void> {
  const h = await getHealth();
  const entry = h[id];
  entry.successes += 1;
  entry.failures = 0;
  entry.cooldownUntil = 0;
  entry.available = true;
  entry.lastError = undefined;
  await persistHealth();
}

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(1000, when - Date.now()) : undefined;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class ProviderError extends Error {
  constructor(message: string, readonly retryAfterMs?: number, readonly fatal = false) {
    super(message);
  }
}

/* ------------------------------ provider calls ---------------------------- */

async function callGemini(
  model: string,
  messages: LLMMessage[],
  key: string,
  jsonMode: boolean
): Promise<string> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2048,
          ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError(
      `gemini ${res.status}: ${body.slice(0, 200)}`,
      parseRetryAfter(res),
      res.status === 401 || res.status === 403
    );
  }
  const json: any = await res.json();
  const text: string =
    json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
  if (!text.trim()) throw new ProviderError('gemini returned an empty candidate');
  return text;
}

/** Groq and OpenRouter both speak the OpenAI chat-completions shape. */
async function callOpenAICompatible(
  endpoint: string,
  model: string,
  messages: LLMMessage[],
  key: string,
  jsonMode: boolean,
  extraHeaders: Record<string, string> = {}
): Promise<string> {
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 2048,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError(
      `${model} ${res.status}: ${body.slice(0, 200)}`,
      parseRetryAfter(res),
      res.status === 401 || res.status === 403
    );
  }
  const json: any = await res.json();
  const text: string = json?.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new ProviderError(`${model} returned an empty choice`);
  return text;
}

/* -------------------------------- the router ------------------------------ */

export interface CompleteOptions {
  /** Ask the provider for strict JSON output where supported. */
  json?: boolean;
  /** Restrict the chain, e.g. ['groq'] for latency-sensitive calls. */
  only?: ProviderId[];
  /** Called whenever the router falls through to another provider. */
  onFallback?: (from: ProviderId, reason: string) => void;
}

/**
 * Runs the provider chain top to bottom, trying each model of each provider.
 * Providers on cooldown are skipped unless every provider is cooling down, in
 * which case the one whose cooldown expires soonest is retried anyway — the
 * agentic loop degrades but never dead-ends.
 */
export async function complete(
  messages: LLMMessage[],
  options: CompleteOptions = {}
): Promise<LLMResult> {
  const settings = await loadSettings();
  const h = await getHealth();
  const now = Date.now();

  const configured = PROVIDERS.filter(
    (p) => settings[p.keyField]?.trim() && (!options.only || options.only.includes(p.id))
  );

  if (configured.length === 0) {
    throw new Error(
      'No LLM API key configured. Add a Gemini, Groq, or OpenRouter key in Settings.'
    );
  }

  const ready = configured.filter((p) => h[p.id].cooldownUntil <= now);
  const chain =
    ready.length > 0
      ? ready
      : [...configured].sort((a, b) => h[a.id].cooldownUntil - h[b.id].cooldownUntil).slice(0, 1);

  const errors: string[] = [];

  for (const provider of chain) {
    const key = settings[provider.keyField].trim();
    for (const model of provider.models) {
      try {
        const text =
          provider.id === 'gemini'
            ? await callGemini(model, messages, key, options.json ?? false)
            : provider.id === 'groq'
            ? await callOpenAICompatible(
                'https://api.groq.com/openai/v1/chat/completions',
                model,
                messages,
                key,
                options.json ?? false
              )
            : await callOpenAICompatible(
                'https://openrouter.ai/api/v1/chat/completions',
                model,
                messages,
                key,
                options.json ?? false,
                {
                  'HTTP-Referer': 'https://github.com/ai-browser-agent',
                  'X-Title': 'AI Browser Agent',
                }
              );
        await markSuccess(provider.id);
        return { text, provider: provider.id, model };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(message);
        const retryAfterMs = err instanceof ProviderError ? err.retryAfterMs : undefined;
        const isRateLimited = /\b429\b|rate.?limit|quota/i.test(message);
        const isFatalKey = err instanceof ProviderError && err.fatal;

        // A rate limit or bad key means the whole provider is out for now;
        // any other error is worth retrying on this provider's next model.
        if (isRateLimited || isFatalKey) {
          await markFailure(provider.id, message, retryAfterMs);
          options.onFallback?.(provider.id, isRateLimited ? 'rate limited' : 'auth failed');
          break;
        }
        if (model === provider.models[provider.models.length - 1]) {
          await markFailure(provider.id, message, retryAfterMs);
          options.onFallback?.(provider.id, message.slice(0, 60));
        }
      }
    }
  }

  throw new Error(`All LLM providers failed.\n${errors.slice(-3).join('\n')}`);
}

/**
 * Convenience wrapper that guarantees a parsed JSON object.
 * Models sometimes wrap JSON in prose or a ```json fence, so we recover the
 * outermost balanced object before parsing.
 */
export async function completeJson<T>(
  messages: LLMMessage[],
  options: CompleteOptions = {}
): Promise<{ value: T; provider: ProviderId }> {
  const result = await complete(messages, { ...options, json: true });
  return { value: extractJson<T>(result.text), provider: result.provider };
}

export function extractJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();

  try {
    return JSON.parse(body) as T;
  } catch {
    /* fall through to brace matching */
  }

  const start = body.search(/[{[]/);
  if (start === -1) throw new Error(`LLM response contained no JSON: ${raw.slice(0, 160)}`);
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      return JSON.parse(body.slice(start, i + 1)) as T;
    }
  }
  throw new Error(`Unbalanced JSON in LLM response: ${raw.slice(0, 160)}`);
}
