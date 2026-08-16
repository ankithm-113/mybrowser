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
  maxAgentSteps: 25,
  autoApplyTopMatches: false,
  confirmBeforeSubmit: true,
};

/** Non-secret settings from AsyncStorage merged with keys from SecureStore. */
export async function loadSettings(): Promise<AppSettings> {
  const stored = await readJson<Partial<AppSettings>>(KEYS.settings, {});
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // Settings saved before custom sources existed have no array here.
  merged.customSources = stored.customSources ?? [];
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
