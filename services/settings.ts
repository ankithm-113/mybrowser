import { AppSettings } from '@/types';
import { KEYS, readJson, writeJson, getSecret, setSecret } from './storage';

export const DEFAULT_SETTINGS: AppSettings = {
  geminiKey: '',
  groqKey: '',
  openrouterKey: '',
  jobSweepTime: '21:00',
  jobSweepEnabled: true,
  jobQueries: ['Software Developer Remote', 'React Native Developer'],
  // Default to the sources that actually fetch jobs headlessly; the
  // browser-only ones are opt-in since they only yield a search link.
  jobSources: ['remoteok', 'arbeitnow', 'jobicy', 'himalayas', 'linkedin'],
  customSources: [],
  minMatchScore: 65,
  // Long-running automation needs room; the wall-clock budget in agentLoop is
  // the real stopping condition.
  maxAgentSteps: 30,
  autoApplyTopMatches: false,
  // Applications and forms run unattended; only money still asks.
  autonomy: 'semi',
};

/** Non-secret settings from AsyncStorage merged with keys from SecureStore. */
export async function loadSettings(): Promise<AppSettings> {
  const stored = await readJson<Partial<AppSettings>>(KEYS.settings, {});
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // Settings saved before custom sources existed have no array here.
  merged.customSources = stored.customSources ?? [];

  // Migrate the old confirmBeforeSubmit boolean. Someone who had turned
  // confirmations off wanted no prompts, so keep that; everyone else lands on
  // semi, which still stops for payments.
  if (!stored.autonomy) {
    const legacy = (stored as { confirmBeforeSubmit?: boolean }).confirmBeforeSubmit;
    merged.autonomy = legacy === false ? 'full' : 'semi';
  }
  merged.geminiKey = await getSecret('geminiKey');
  merged.groqKey = await getSecret('groqKey');
  merged.openrouterKey = await getSecret('openrouterKey');
  return merged;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const { geminiKey, groqKey, openrouterKey, ...rest } = settings;
  await writeJson(KEYS.settings, rest);
  await setSecret('geminiKey', geminiKey.trim());
  await setSecret('groqKey', groqKey.trim());
  await setSecret('openrouterKey', openrouterKey.trim());
}
