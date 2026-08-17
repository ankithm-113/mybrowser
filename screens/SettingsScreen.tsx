import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Icon from '@/components/Icon';
import { TAB_BAR_INSET } from '@/components/layout';
import { colors, radius, shared, space, switchColors, type } from '@/components/theme';
import {
  Button,
  Chip,
  Divider,
  Field,
  GlassCard,
  SectionHeader,
  SecretField,
} from '@/components/ui';
import {
  clearCooldowns,
  getProviderHealth,
  PROVIDERS,
  ProviderTestResult,
  testAllProviders,
} from '@/services/apiManager';
import { alert } from '@/services/dialog';
import { configureScheduler, listSourceLabels, testSource } from '@/services/jobScheduler';
import { SOURCE_PRESETS } from '@/services/jobSources';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '@/services/settings';
import { newId } from '@/services/storage';
import { AppSettings, CustomJobSource, ProviderHealth, ProviderId } from '@/types';

export default function SettingsScreen() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tests, setTests] = useState<Record<ProviderId, ProviderTestResult>>(
    {} as Record<ProviderId, ProviderTestResult>
  );

  const [addingSource, setAddingSource] = useState(false);
  const [testingSource, setTestingSource] = useState(false);
  const [draft, setDraft] = useState<{ label: string; kind: 'rss' | 'browser'; url: string }>({
    label: '',
    kind: 'rss',
    url: '',
  });

  const refreshHealth = useCallback(async () => setHealth(await getProviderHealth()), []);

  /* ---------------------------- custom job sources --------------------------- */

  const addSource = useCallback(
    (label: string, kind: 'rss' | 'browser', url: string) => {
      const cleanLabel = label.trim();
      const cleanUrl = url.trim();

      if (!cleanLabel || !cleanUrl) {
        void alert('Missing details', 'Give the source a name and a URL.');
        return;
      }
      if (!/^https?:\/\//i.test(cleanUrl)) {
        void alert('Invalid URL', 'The URL must start with http:// or https://');
        return;
      }

      const source: CustomJobSource = { id: newId('src'), label: cleanLabel, kind, url: cleanUrl };
      setSettings((s) => ({
        ...s,
        customSources: [...s.customSources, source],
        // A source you just added is one you want used.
        jobSources: [...s.jobSources, source.id],
      }));
      setDraft({ label: '', kind: 'rss', url: '' });
      setAddingSource(false);
    },
    []
  );

  const removeSource = useCallback((id: string) => {
    setSettings((s) => ({
      ...s,
      customSources: s.customSources.filter((c) => c.id !== id),
      jobSources: s.jobSources.filter((x) => x !== id),
    }));
  }, []);

  /** Fetches the draft feed once so a broken URL is caught before it's saved. */
  const testDraft = useCallback(async () => {
    if (!/^https?:\/\//i.test(draft.url.trim())) {
      void alert('Invalid URL', 'The URL must start with http:// or https://');
      return;
    }
    setTestingSource(true);
    const result = await testSource(
      { id: 'draft', label: draft.label.trim() || 'Draft', kind: draft.kind, url: draft.url.trim() },
      settings.jobQueries[0] ?? 'developer'
    );
    setTestingSource(false);
    void alert(result.ok ? 'Source works' : 'Source failed', result.detail);
  }, [draft, settings.jobQueries]);

  useEffect(() => {
    (async () => {
      setSettings(await loadSettings());
      await refreshHealth();
      setLoading(false);
    })();
  }, [refreshHealth]);

  /**
   * Saves first — otherwise a key typed but not yet persisted would be tested
   * as empty — then calls each provider and records the exact failure.
   */
  const runTests = useCallback(async () => {
    setTesting(true);
    await saveSettings(settings);
    const results = await testAllProviders();
    setTests(
      results.reduce(
        (acc, r) => ({ ...acc, [r.id]: r }),
        {} as Record<ProviderId, ProviderTestResult>
      )
    );
    await refreshHealth();
    setTesting(false);

    const working = results.filter((r) => r.ok);
    void alert(
      working.length ? `${working.length} of ${results.length} providers working` : 'All providers failed',
      results
        .map((r) => `${r.label}\n${r.ok ? `OK (${r.latencyMs}ms) via ${r.model}` : r.detail}`)
        .join('\n\n')
    );
  }, [settings, refreshHealth]);

  const save = useCallback(async () => {
    if (!/^\d{1,2}:\d{2}$/.test(settings.jobSweepTime)) {
      void alert('Invalid time', 'Use 24-hour HH:MM, for example 21:00.');
      return;
    }
    setSaving(true);
    await saveSettings(settings);
    const scheduler = await configureScheduler();
    await refreshHealth();
    setSaving(false);
    void alert(
      'Settings saved',
      `Notifications: ${scheduler.notifications ? 'granted' : 'denied'}\n` +
        `Background fetch: ${scheduler.backgroundFetch ? 'registered' : 'unavailable'}`
    );
  }, [settings, refreshHealth]);

  if (loading) {
    return (
      <SafeAreaView style={[shared.screen, styles.center]}>
        <ActivityIndicator color={colors.text} />
      </SafeAreaView>
    );
  }

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const toggleSource = (id: string) =>
    setSettings((s) => ({
      ...s,
      jobSources: s.jobSources.includes(id)
        ? s.jobSources.filter((x) => x !== id)
        : [...s.jobSources, id],
    }));

  const configuredCount = [settings.geminiKey, settings.groqKey, settings.openrouterKey].filter(
    (k) => k.trim()
  ).length;

  return (
    <SafeAreaView style={shared.screen} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={shared.display}>Settings</Text>
          <Text style={shared.dim}>
            Keys live in the device keychain and are sent only to the provider they belong to.
          </Text>
        </View>

        {/* --------------------------------- keys -------------------------------- */}
        <View style={styles.keysHeader}>
          <SectionHeader title="API keys" />
          <Text style={shared.dim}>
            {configuredCount} of 3 configured. All three tiers are free — add more than one so the
            router can fail over when a provider rate-limits you.
          </Text>
        </View>

        <SecretField
          label="Google Gemini"
          role="Primary"
          value={settings.geminiKey}
          onChangeText={(t) => set('geminiKey', t.trim())}
          placeholder="AIza..."
          source="aistudio.google.com/apikey"
        />
        <SecretField
          label="Groq"
          role="First fallback"
          value={settings.groqKey}
          onChangeText={(t) => set('groqKey', t.trim())}
          placeholder="gsk_..."
          source="console.groq.com/keys"
        />
        <SecretField
          label="OpenRouter"
          role="Final fallback"
          value={settings.openrouterKey}
          onChangeText={(t) => set('openrouterKey', t.trim())}
          placeholder="sk-or-..."
          source="openrouter.ai/keys"
        />
        <View style={styles.spacer} />

        {/* ------------------------------- provider ------------------------------ */}
        <GlassCard>
          <SectionHeader
            title="Provider status"
            action="Reset cooldowns"
            onAction={async () => {
              await clearCooldowns();
              await refreshHealth();
            }}
          />

          {PROVIDERS.map((provider, index) => {
            const entry = health.find((h) => h.id === provider.id);
            const cooling = (entry?.cooldownUntil ?? 0) > Date.now();
            const configured = !!settings[provider.keyField]?.trim();
            const test = tests[provider.id];
            const passed = test?.ok === true;

            return (
              <View key={provider.id}>
                {index > 0 && <Divider />}
                <View style={styles.healthRow}>
                  <View style={styles.flex}>
                    <Text style={shared.bodyStrong}>{provider.label}</Text>
                    <Text style={shared.dim} numberOfLines={2}>
                      {!configured
                        ? 'No key configured'
                        : test
                        ? passed
                          ? `Working — ${test.model} in ${test.latencyMs}ms`
                          : 'Test failed, see below'
                        : cooling
                        ? `Cooling down until ${new Date(entry!.cooldownUntil).toLocaleTimeString()}`
                        : entry?.lastError
                        ? `Last error: ${entry.lastError}`
                        : `${entry?.successes ?? 0} successful calls`}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.statusDot,
                      (test ? passed : configured && !cooling)
                        ? styles.statusDotOk
                        : styles.statusDotOff,
                    ]}
                  >
                    {(test ? passed : configured && !cooling) && (
                      <Icon name="check" size={10} color={colors.onFill} />
                    )}
                  </View>
                </View>

                {/* Full, unshortened error — this is the whole point of the test. */}
                {test && !test.ok && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText} selectable>
                      {test.detail}
                    </Text>
                  </View>
                )}
              </View>
            );
          })}

          <View style={styles.spacer} />
          <Button
            label="Test all providers"
            variant="secondary"
            onPress={runTests}
            loading={testing}
          />
          <Text style={[shared.dim, styles.testHint]}>
            Saves your keys, then sends a one-word prompt to each provider and shows the exact
            response. Full request logs also print to the Metro terminal.
          </Text>
        </GlassCard>

        {/* --------------------------------- sweep ------------------------------- */}
        <GlassCard>
          <SectionHeader title="Nightly job sweep" />

          <View style={styles.toggleRow}>
            <View style={styles.flex}>
              <Text style={shared.bodyStrong}>Enabled</Text>
              <Text style={shared.dim}>Searches your boards once a day and notifies you.</Text>
            </View>
            <Switch
              value={settings.jobSweepEnabled}
              onValueChange={(v) => set('jobSweepEnabled', v)}
              {...switchColors}
            />
          </View>

          <Divider />
          <View style={styles.spacer} />

          <Field
            label="Run at (24h)"
            value={settings.jobSweepTime}
            onChangeText={(t) => set('jobSweepTime', t)}
            placeholder="21:00"
            keyboardType="numbers-and-punctuation"
          />

          <Field
            label="Search queries"
            value={settings.jobQueries.join('\n')}
            onChangeText={(t) =>
              set('jobQueries', t.split('\n').map((s) => s.trim()).filter(Boolean))
            }
            placeholder={'Software Developer Remote\nReact Native Developer'}
            hint="One query per line"
            multiline
          />

          <Text style={shared.label}>Minimum match score</Text>
          <View style={styles.chipRow}>
            {[40, 55, 65, 75, 85].map((value) => (
              <Chip
                key={value}
                label={String(value)}
                selected={settings.minMatchScore === value}
                onPress={() => set('minMatchScore', value)}
              />
            ))}
          </View>

          <Text style={shared.label}>Sources</Text>
          <View style={styles.chipRow}>
            {listSourceLabels(settings.customSources).map((source) => (
              <Chip
                key={source.id}
                label={source.label}
                selected={settings.jobSources.includes(source.id)}
                onPress={() => toggleSource(source.id)}
              />
            ))}
          </View>
          <Text style={shared.dim}>
            Indeed, Glassdoor and Wellfound block plain HTTP clients, so those produce a search link
            the in-app browser agent opens with a real session instead.
          </Text>
        </GlassCard>

        {/* ----------------------------- custom sources -------------------------- */}
        <GlassCard>
          <SectionHeader
            title="Add job sources"
            action={addingSource ? 'Cancel' : 'Add custom'}
            onAction={() => setAddingSource((v) => !v)}
          />

          <Text style={[shared.dim, styles.introSpaced]}>
            RSS feeds are fetched headlessly during the nightly sweep. Browser sources open a search
            page for the agent to read. Put {'{query}'} in the URL to insert your search terms.
          </Text>

          <Text style={shared.label}>Quick add</Text>
          <View style={styles.chipRow}>
            {SOURCE_PRESETS.filter(
              (p) => !settings.customSources.some((c) => c.label === p.label)
            ).map((preset) => (
              <Chip
                key={preset.label}
                label={`${preset.label} · ${preset.kind}`}
                onPress={() => addSource(preset.label, preset.kind, preset.url)}
              />
            ))}
          </View>

          {addingSource && (
            <View style={styles.addBox}>
              <Field
                label="Name"
                value={draft.label}
                onChangeText={(t) => setDraft((d) => ({ ...d, label: t }))}
                placeholder="My job board"
              />
              <Text style={shared.label}>Type</Text>
              <View style={styles.chipRow}>
                <Chip
                  label="RSS feed"
                  selected={draft.kind === 'rss'}
                  onPress={() => setDraft((d) => ({ ...d, kind: 'rss' }))}
                />
                <Chip
                  label="Browser search"
                  selected={draft.kind === 'browser'}
                  onPress={() => setDraft((d) => ({ ...d, kind: 'browser' }))}
                />
              </View>
              <Field
                label="URL"
                value={draft.url}
                onChangeText={(t) => setDraft((d) => ({ ...d, url: t }))}
                placeholder={
                  draft.kind === 'rss'
                    ? 'https://example.com/jobs.rss'
                    : 'https://example.com/search?q={query}'
                }
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.addActions}>
                <Button
                  label="Test"
                  variant="secondary"
                  onPress={testDraft}
                  loading={testingSource}
                  style={styles.flex}
                  small
                />
                <Button
                  label="Add source"
                  onPress={() => addSource(draft.label, draft.kind, draft.url)}
                  style={styles.flex}
                  small
                />
              </View>
            </View>
          )}

          {settings.customSources.length > 0 && (
            <View>
              <View style={styles.spacer} />
              <Text style={shared.label}>Your sources</Text>
              {settings.customSources.map((source, index) => (
                <View key={source.id}>
                  {index > 0 && <Divider />}
                  <View style={styles.healthRow}>
                    <View style={styles.flex}>
                      <Text style={shared.bodyStrong}>{source.label}</Text>
                      <Text style={shared.dim} numberOfLines={1}>
                        {source.kind.toUpperCase()} · {source.url}
                      </Text>
                    </View>
                    <Button
                      label="Remove"
                      variant="secondary"
                      onPress={() => removeSource(source.id)}
                      small
                    />
                  </View>
                </View>
              ))}
            </View>
          )}
        </GlassCard>

        {/* ------------------------------- behaviour ----------------------------- */}
        <GlassCard>
          <SectionHeader title="Agent behaviour" />

          <Text style={shared.label}>Max steps per run</Text>
          <View style={styles.chipRow}>
            {[15, 30, 50, 80].map((value) => (
              <Chip
                key={value}
                label={String(value)}
                selected={settings.maxAgentSteps === value}
                onPress={() => set('maxAgentSteps', value)}
              />
            ))}
          </View>

          <Divider />
          <View style={styles.spacer} />

          <View style={styles.toggleRow}>
            <View style={styles.flex}>
              <Text style={shared.bodyStrong}>Ask before submitting</Text>
              <Text style={shared.dim}>
                Prompts you before the agent clicks anything that looks like a final submit.
              </Text>
            </View>
            <Switch
              value={settings.confirmBeforeSubmit}
              onValueChange={(v) => set('confirmBeforeSubmit', v)}
              {...switchColors}
            />
          </View>
        </GlassCard>

        <Button label="Save settings" onPress={save} loading={saving} />
        <View style={styles.bottomSpace} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: space.lg, paddingTop: space.sm },
  header: { marginBottom: space.lg, gap: space.sm },
  keysHeader: { marginBottom: space.md },
  flex: { flex: 1 },
  healthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
  },
  statusDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDotOk: { backgroundColor: colors.fill },
  statusDotOff: { borderWidth: 1.5, borderColor: colors.borderStrong },
  errorBox: {
    backgroundColor: colors.sunken,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    marginBottom: space.md,
  },
  errorText: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  testHint: { marginTop: space.sm },
  introSpaced: { marginBottom: space.lg },
  addBox: {
    backgroundColor: colors.sunkenAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    marginTop: space.sm,
  },
  addActions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.lg,
    paddingVertical: space.sm,
  },
  spacer: { height: space.lg },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg },
  bottomSpace: { height: TAB_BAR_INSET },
});
