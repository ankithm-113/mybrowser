/**
 * Free job feeds.
 *
 * Everything here is either a public JSON API with no key, or a public
 * guest-accessible HTML endpoint. No paid aggregator, no scraping service.
 *
 * HTML sources are inherently brittle — markup changes break them silently, so
 * each one fails soft and the sweep continues with whatever else responded.
 */

import { CustomJobSource, JobMatch } from '@/types';
import { newId } from './storage';

export interface RawJob {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  source: string;
  postedAt?: string;
  snippet?: string;
}

export interface JobSource {
  id: string;
  label: string;
  kind: 'api' | 'html';
  fetchJobs(query: string): Promise<RawJob[]>;
}

const FETCH_TIMEOUT_MS = 20_000;
const PER_SOURCE_LIMIT = 25;

async function getWithTimeout(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
        Accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
        ...headers,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/* --------------------------------- sources -------------------------------- */

const remoteok: JobSource = {
  id: 'remoteok',
  label: 'RemoteOK',
  kind: 'api',
  async fetchJobs(query) {
    const res = await getWithTimeout('https://remoteok.com/api');
    if (!res.ok) throw new Error(`remoteok ${res.status}`);
    const rows: any[] = await res.json();
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    return rows
      .filter((r) => r && r.position)
      .filter((r) => {
        const hay = `${r.position} ${r.tags?.join(' ') ?? ''} ${r.company ?? ''}`.toLowerCase();
        return terms.length === 0 || terms.some((t) => hay.includes(t));
      })
      .slice(0, PER_SOURCE_LIMIT)
      .map((r) => ({
        id: `remoteok:${r.id}`,
        title: r.position,
        company: r.company ?? 'Unknown',
        location: r.location || 'Remote',
        url: r.url ?? `https://remoteok.com/l/${r.id}`,
        source: 'RemoteOK',
        postedAt: r.date,
        snippet: stripHtml(r.description ?? '').slice(0, 600),
      }));
  },
};

const arbeitnow: JobSource = {
  id: 'arbeitnow',
  label: 'Arbeitnow',
  kind: 'api',
  async fetchJobs(query) {
    const res = await getWithTimeout('https://www.arbeitnow.com/api/job-board-api');
    if (!res.ok) throw new Error(`arbeitnow ${res.status}`);
    const json: any = await res.json();
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    return (json.data ?? [])
      .filter((r: any) => {
        const hay = `${r.title} ${r.tags?.join(' ') ?? ''}`.toLowerCase();
        return terms.length === 0 || terms.some((t) => hay.includes(t));
      })
      .slice(0, PER_SOURCE_LIMIT)
      .map((r: any) => ({
        id: `arbeitnow:${r.slug}`,
        title: r.title,
        company: r.company_name,
        location: r.remote ? `Remote / ${r.location}` : r.location,
        url: r.url,
        source: 'Arbeitnow',
        postedAt: r.created_at ? new Date(r.created_at * 1000).toISOString() : undefined,
        snippet: stripHtml(r.description ?? '').slice(0, 600),
      }));
  },
};

const jobicy: JobSource = {
  id: 'jobicy',
  label: 'Jobicy',
  kind: 'api',
  async fetchJobs(query) {
    const res = await getWithTimeout(
      `https://jobicy.com/api/v2/remote-jobs?count=${PER_SOURCE_LIMIT}&tag=${encodeURIComponent(query)}`
    );
    if (!res.ok) throw new Error(`jobicy ${res.status}`);
    const json: any = await res.json();
    return (json.jobs ?? []).map((r: any) => ({
      id: `jobicy:${r.id}`,
      title: r.jobTitle,
      company: r.companyName,
      location: r.jobGeo || 'Remote',
      url: r.url,
      source: 'Jobicy',
      postedAt: r.pubDate,
      snippet: stripHtml(r.jobExcerpt ?? r.jobDescription ?? '').slice(0, 600),
    }));
  },
};

const himalayas: JobSource = {
  id: 'himalayas',
  label: 'Himalayas',
  kind: 'api',
  async fetchJobs(query) {
    const res = await getWithTimeout('https://himalayas.app/jobs/api?limit=100');
    if (!res.ok) throw new Error(`himalayas ${res.status}`);
    const json: any = await res.json();
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    return (json.jobs ?? [])
      .filter((r: any) => {
        const hay = `${r.title} ${r.categories?.join(' ') ?? ''}`.toLowerCase();
        return terms.length === 0 || terms.some((t) => hay.includes(t));
      })
      .slice(0, PER_SOURCE_LIMIT)
      .map((r: any) => ({
        id: `himalayas:${r.guid ?? r.applicationLink}`,
        title: r.title,
        company: r.companyName,
        location: r.locationRestrictions?.join(', ') || 'Remote',
        url: r.applicationLink ?? r.url,
        source: 'Himalayas',
        postedAt: r.pubDate,
        snippet: stripHtml(r.excerpt ?? r.description ?? '').slice(0, 600),
      }));
  },
};

/**
 * LinkedIn's guest job-search endpoint returns server-rendered cards without a
 * login. It is rate limited and the markup changes; treat failures as normal.
 */
const linkedin: JobSource = {
  id: 'linkedin',
  label: 'LinkedIn (guest)',
  kind: 'html',
  async fetchJobs(query) {
    const url =
      'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search' +
      `?keywords=${encodeURIComponent(query)}&location=${encodeURIComponent('Worldwide')}&start=0`;
    const res = await getWithTimeout(url, { Accept: 'text/html' });
    if (!res.ok) throw new Error(`linkedin ${res.status}`);
    const html = await res.text();

    const cards = html.split('<li>').slice(1, PER_SOURCE_LIMIT + 1);
    const jobs: RawJob[] = [];
    for (const card of cards) {
      const href = card.match(/href="(https:\/\/[^"?]+\/jobs\/view\/[^"?]+)/)?.[1];
      const title = card.match(/base-search-card__title"[^>]*>([\s\S]*?)<\//)?.[1];
      const company = card.match(/hidden-nested-link"[^>]*>([\s\S]*?)<\//)?.[1];
      const location = card.match(/job-search-card__location"[^>]*>([\s\S]*?)<\//)?.[1];
      const posted = card.match(/datetime="([^"]+)"/)?.[1];
      if (!href || !title) continue;
      jobs.push({
        id: `linkedin:${href.split('/').pop()}`,
        title: stripHtml(title),
        company: stripHtml(company ?? 'Unknown'),
        location: stripHtml(location ?? ''),
        url: href,
        source: 'LinkedIn',
        postedAt: posted,
      });
    }
    if (!jobs.length) throw new Error('linkedin returned no parseable cards');
    return jobs;
  },
};

/**
 * Indeed and Glassdoor both sit behind Cloudflare for plain HTTP clients, so
 * the background sweep cannot read them reliably. They are registered here as
 * "open in the browser tab" sources: the sweep records a search URL the user
 * (or the foreground agent) can drive with a real WebView session.
 */
function browserOnlySource(id: string, label: string, template: (q: string) => string): JobSource {
  return {
    id,
    label,
    kind: 'html',
    async fetchJobs(query) {
      return [
        {
          id: `${id}:search:${query}`,
          title: `Open ${label} search: ${query}`,
          company: label,
          location: 'Search page',
          url: template(query),
          source: label,
          snippet:
            `${label} blocks plain HTTP clients, so this entry opens the live search in the ` +
            'in-app browser where the agent can read it with a real session.',
        },
      ];
    },
  };
}

const indeed = browserOnlySource(
  'indeed',
  'Indeed',
  (q) => `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&sort=date`
);
const glassdoor = browserOnlySource(
  'glassdoor',
  'Glassdoor',
  (q) => `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(q)}`
);
const wellfound = browserOnlySource(
  'wellfound',
  'Wellfound',
  (q) => `https://wellfound.com/jobs?query=${encodeURIComponent(q)}`
);

export const JOB_SOURCES: JobSource[] = [
  remoteok,
  arbeitnow,
  jobicy,
  himalayas,
  linkedin,
  indeed,
  glassdoor,
  wellfound,
];

/* ----------------------------- custom sources ----------------------------- */

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&'); // last, so &amp;lt; resolves correctly
}

/**
 * Pull one tag's text out of an RSS/Atom item.
 *
 * Feed descriptions routinely carry HTML that is *entity-escaped* inside the
 * XML, so stripping tags before decoding leaves literal "&lt;p&gt;" in the
 * text. Decode first, then strip, then decode once more to catch the
 * double-encoding some generators emit.
 */
function tagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!match) return undefined;

  const raw = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return stripHtml(decodeEntities(stripHtml(decodeEntities(raw)))) || undefined;
}

/** Atom carries the URL in an attribute rather than the element body. */
function atomLink(xml: string): string | undefined {
  return /<link[^>]*href="([^"]+)"/i.exec(xml)?.[1];
}

/**
 * Minimal RSS 2.0 + Atom reader. Deliberately regex-based: pulling in an XML
 * parser for four fields is not worth the dependency, and job feeds are
 * uniformly simple documents.
 */
export function parseFeed(xml: string, sourceLabel: string, sourceId: string): RawJob[] {
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) ?? [];

  return blocks
    .slice(0, PER_SOURCE_LIMIT)
    .map((block, index): RawJob | null => {
      const title = tagText(block, 'title');
      const link = tagText(block, 'link') || atomLink(block);
      if (!title || !link) return null;

      const description =
        tagText(block, 'description') ?? tagText(block, 'summary') ?? tagText(block, 'content');

      return {
        // Prefer the feed's own id so repeat sweeps dedupe correctly.
        id: `${sourceId}:${tagText(block, 'guid') ?? tagText(block, 'id') ?? link ?? index}`,
        title,
        // Feeds rarely separate out the company; fall back to the source name.
        company: tagText(block, 'dc:creator') ?? tagText(block, 'author') ?? sourceLabel,
        location: tagText(block, 'location') ?? '',
        url: link,
        source: sourceLabel,
        postedAt: tagText(block, 'pubDate') ?? tagText(block, 'updated'),
        snippet: description?.slice(0, 600),
      };
    })
    .filter((j): j is RawJob => j !== null);
}

function buildCustomSource(custom: CustomJobSource): JobSource {
  return {
    id: custom.id,
    label: custom.label,
    kind: custom.kind === 'rss' ? 'api' : 'html',
    async fetchJobs(query) {
      const url = custom.url.replace(/\{query\}/gi, encodeURIComponent(query));

      if (custom.kind === 'browser') {
        return [
          {
            id: `${custom.id}:search:${query}`,
            title: `Open ${custom.label} search: ${query}`,
            company: custom.label,
            location: 'Search page',
            url,
            source: custom.label,
            snippet: `Opens the live ${custom.label} search in the in-app browser for the agent to read.`,
          },
        ];
      }

      const res = await getWithTimeout(url, { Accept: 'application/rss+xml, application/xml' });
      if (!res.ok) throw new Error(`${custom.label} HTTP ${res.status}`);
      const jobs = parseFeed(await res.text(), custom.label, custom.id);
      if (!jobs.length) throw new Error(`${custom.label} returned no parseable feed items`);
      return jobs;
    },
  };
}

/** Built-in sources plus the user's own, in one list. */
export function resolveSources(customs: CustomJobSource[] = []): JobSource[] {
  return [...JOB_SOURCES, ...customs.map(buildCustomSource)];
}

export function getSource(id: string, customs: CustomJobSource[] = []): JobSource | undefined {
  return resolveSources(customs).find((s) => s.id === id);
}

/** Ready-made feeds the user can add with one tap. */
export const SOURCE_PRESETS: Array<Omit<CustomJobSource, 'id'>> = [
  { label: 'We Work Remotely', kind: 'rss', url: 'https://weworkremotely.com/remote-jobs.rss' },
  {
    label: 'WWR Programming',
    kind: 'rss',
    url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss',
  },
  {
    label: 'WWR Full-Stack',
    kind: 'rss',
    url: 'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
  },
  { label: 'Jobicy Feed', kind: 'rss', url: 'https://jobicy.com/?feed=job_feed' },
  { label: 'Naukri', kind: 'browser', url: 'https://www.naukri.com/{query}-jobs' },
  {
    label: 'Google Jobs',
    kind: 'browser',
    url: 'https://www.google.com/search?q={query}+jobs&ibp=htl;jobs',
  },
  {
    label: 'Y Combinator',
    kind: 'browser',
    url: 'https://www.ycombinator.com/jobs?query={query}',
  },
];

export function toJobMatch(raw: RawJob, score: number, reason: string): JobMatch {
  return {
    id: raw.id || newId('job'),
    title: raw.title,
    company: raw.company,
    location: raw.location,
    url: raw.url,
    source: raw.source,
    postedAt: raw.postedAt,
    snippet: raw.snippet,
    matchScore: score,
    matchReason: reason,
    status: 'new',
    foundAt: Date.now(),
  };
}
