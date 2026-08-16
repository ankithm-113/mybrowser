/**
 * Autonomous background job finder.
 *
 * Two independent triggers, because mobile OSes will not guarantee either one:
 *   1. A daily scheduled notification at the configured time (default 21:00)
 *      whose handler runs the sweep when the app is opened or woken.
 *   2. expo-background-fetch, which the OS runs opportunistically. It checks
 *      whether today's sweep already ran and skips if so.
 *
 * The sweep itself is network-only (no WebView needed), so it works headlessly.
 */

import * as BackgroundFetch from 'expo-background-fetch';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { JobMatch } from '@/types';
import { completeJson } from './apiManager';
import { buildVaultContext, loadVault } from './knowledgeVault';
import { JOB_SOURCES, RawJob, getSource, toJobMatch } from './jobSources';
import { JOB_MATCH_SYSTEM_PROMPT } from './prompts';
import { loadSettings } from './settings';
import { KEYS, readJson, writeJson } from './storage';

export const JOB_SWEEP_TASK = 'aiba-nightly-job-sweep';
const LAST_SWEEP_KEY = 'aiba.lastSweep.v1';
const SCORING_BATCH_SIZE = 12;
const MAX_STORED_JOBS = 400;

/* ------------------------------ job store --------------------------------- */

export async function loadJobs(): Promise<JobMatch[]> {
  return readJson<JobMatch[]>(KEYS.jobs, []);
}

export async function saveJobs(jobs: JobMatch[]): Promise<void> {
  const trimmed = [...jobs].sort((a, b) => b.foundAt - a.foundAt).slice(0, MAX_STORED_JOBS);
  await writeJson(KEYS.jobs, trimmed);
}

export async function updateJob(id: string, patch: Partial<JobMatch>): Promise<JobMatch[]> {
  const jobs = await loadJobs();
  const next = jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
  await saveJobs(next);
  return next;
}

/* -------------------------------- the sweep ------------------------------- */

export interface SweepResult {
  found: number;
  matched: number;
  errors: string[];
  ranAt: number;
}

async function fetchAllSources(queries: string[], sourceIds: string[]): Promise<{
  jobs: RawJob[];
  errors: string[];
}> {
  const errors: string[] = [];
  const seen = new Set<string>();
  const jobs: RawJob[] = [];

  const tasks: Array<Promise<void>> = [];
  for (const sourceId of sourceIds) {
    const source = getSource(sourceId);
    if (!source) continue;
    for (const query of queries) {
      tasks.push(
        source
          .fetchJobs(query)
          .then((rows) => {
            for (const row of rows) {
              if (!row.url || seen.has(row.id)) continue;
              seen.add(row.id);
              jobs.push(row);
            }
          })
          // One dead source must never abort the sweep.
          .catch((err) => {
            errors.push(`${source.label} / "${query}": ${err instanceof Error ? err.message : err}`);
          })
      );
    }
  }

  await Promise.all(tasks);
  return { jobs, errors };
}

/** Scores postings against the vault in batches, tolerating provider failures. */
async function scoreJobs(
  raw: RawJob[],
  vaultContext: string
): Promise<Map<string, { matchScore: number; matchReason: string }>> {
  const scores = new Map<string, { matchScore: number; matchReason: string }>();

  for (let i = 0; i < raw.length; i += SCORING_BATCH_SIZE) {
    const batch = raw.slice(i, i + SCORING_BATCH_SIZE);
    const listing = batch
      .map(
        (j) =>
          `- id: ${j.id}\n  title: ${j.title}\n  company: ${j.company}\n  location: ${j.location}\n  summary: ${(
            j.snippet ?? ''
          ).slice(0, 400)}`
      )
      .join('\n');

    try {
      const { value } = await completeJson<{
        matches: Array<{ id: string; matchScore: number; matchReason: string }>;
      }>([
        { role: 'system', content: JOB_MATCH_SYSTEM_PROMPT },
        { role: 'user', content: `${vaultContext}\n\n## POSTINGS\n${listing}` },
      ]);

      for (const m of value.matches ?? []) {
        scores.set(m.id, {
          matchScore: Math.max(0, Math.min(100, Number(m.matchScore) || 0)),
          matchReason: m.matchReason ?? '',
        });
      }
    } catch {
      // Unscored postings still reach the review screen, just flagged as such.
      for (const j of batch) {
        scores.set(j.id, { matchScore: 50, matchReason: 'Not scored — AI providers were unavailable.' });
      }
    }
  }

  return scores;
}

export async function runJobSweep(): Promise<SweepResult> {
  const settings = await loadSettings();
  const vault = await loadVault();
  const vaultContext = buildVaultContext(vault, { includeResume: true });

  const { jobs: raw, errors } = await fetchAllSources(settings.jobQueries, settings.jobSources);

  const existing = await loadJobs();
  const known = new Set(existing.map((j) => j.id));
  const fresh = raw.filter((j) => !known.has(j.id));

  const scores = await scoreJobs(fresh, vaultContext);

  const matches = fresh
    .map((j) => {
      const s = scores.get(j.id) ?? { matchScore: 0, matchReason: 'No score returned.' };
      return toJobMatch(j, s.matchScore, s.matchReason);
    })
    .filter((j) => j.matchScore >= settings.minMatchScore);

  await saveJobs([...matches, ...existing]);
  await writeJson(LAST_SWEEP_KEY, { at: Date.now(), found: fresh.length, matched: matches.length });

  if (matches.length > 0) {
    const top = matches.sort((a, b) => b.matchScore - a.matchScore)[0];
    // The channel must exist before delivery, or Android drops this onto the
    // default (low-importance) channel and it never heads-up displays.
    await requestNotificationPermission();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${matches.length} new job match${matches.length === 1 ? '' : 'es'} to review`,
        body: `Top pick: ${top.title} at ${top.company} (${top.matchScore}% match). Tap to review.`,
        data: { screen: 'JobReview' },
      },
      trigger:
        Platform.OS === 'android' ? ({ channelId: 'job-alerts', seconds: 1 } as any) : null,
    });
  }

  return { found: fresh.length, matched: matches.length, errors, ranAt: Date.now() };
}

export async function getLastSweep(): Promise<{ at: number; found: number; matched: number } | null> {
  return readJson<{ at: number; found: number; matched: number } | null>(LAST_SWEEP_KEY, null);
}

async function alreadySweptToday(): Promise<boolean> {
  const last = await getLastSweep();
  if (!last) return false;
  const then = new Date(last.at);
  const now = new Date();
  return (
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate()
  );
}

/* ------------------------------ registration ------------------------------ */

TaskManager.defineTask(JOB_SWEEP_TASK, async () => {
  try {
    const settings = await loadSettings();
    if (!settings.jobSweepEnabled) return BackgroundFetch.BackgroundFetchResult.NoData;

    const [hour] = settings.jobSweepTime.split(':').map(Number);
    const now = new Date();
    // Only sweep at or after the configured hour, and only once per day.
    if (now.getHours() < hour) return BackgroundFetch.BackgroundFetchResult.NoData;
    if (await alreadySweptToday()) return BackgroundFetch.BackgroundFetchResult.NoData;

    const result = await runJobSweep();
    return result.matched > 0
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function requestNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  let granted = current.granted;
  if (!granted) granted = (await Notifications.requestPermissionsAsync()).granted;

  if (granted && Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('job-alerts', {
      name: 'Job matches',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }
  return granted;
}

/**
 * Schedules the daily reminder and registers the opportunistic background
 * fetch. Safe to call on every app start — both registrations are idempotent.
 */
export async function configureScheduler(): Promise<{ notifications: boolean; backgroundFetch: boolean }> {
  const settings = await loadSettings();
  const notifications = await requestNotificationPermission();

  await Notifications.cancelAllScheduledNotificationsAsync();

  if (settings.jobSweepEnabled && notifications) {
    const [hour, minute] = settings.jobSweepTime.split(':').map(Number);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Nightly job sweep',
        body: 'Searching your job boards for new matches...',
        data: { screen: 'JobReview', action: 'sweep' },
      },
      trigger: {
        repeats: true,
        hour: Number.isFinite(hour) ? hour : 21,
        minute: Number.isFinite(minute) ? minute : 0,
        channelId: 'job-alerts',
      },
    });
  }

  let backgroundFetch = false;
  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (status === BackgroundFetch.BackgroundFetchStatus.Available && settings.jobSweepEnabled) {
      await BackgroundFetch.registerTaskAsync(JOB_SWEEP_TASK, {
        minimumInterval: 60 * 60, // OS treats this as a floor, not a promise
        stopOnTerminate: false,
        startOnBoot: true,
      });
      backgroundFetch = true;
    } else if (!settings.jobSweepEnabled) {
      const registered = await TaskManager.isTaskRegisteredAsync(JOB_SWEEP_TASK);
      if (registered) await BackgroundFetch.unregisterTaskAsync(JOB_SWEEP_TASK);
    }
  } catch {
    backgroundFetch = false;
  }

  return { notifications, backgroundFetch };
}

export function listSourceLabels(): Array<{ id: string; label: string; kind: string }> {
  return JOB_SOURCES.map((s) => ({ id: s.id, label: s.label, kind: s.kind }));
}
