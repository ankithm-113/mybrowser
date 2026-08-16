import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Icon from '@/components/Icon';
import { colors, radius, shared, space, switchColors, type } from '@/components/theme';
import {
  Button,
  Chip,
  Divider,
  Field,
  SectionHeader,
  SecretField,
} from '@/components/ui';
import { clearCooldowns, getProviderHealth, PROVIDERS } from '@/services/apiManager';
import { alert } from '@/services/dialog';
import { configureScheduler, listSourceLabels } from '@/services/jobScheduler';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '@/services/settings';
import { AppSettings, ProviderHealth } from '@/types';

export default function SettingsScreen() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const refreshHealth = useCallback(async () => setHealth(await getProviderHealth()), []);

  useEffect(() => {
    (async () => {
      setSettings(await loadSettings());
      await refreshHealth();
      setLoading(false);
    })();
  }, [refreshHealth]);

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
        <View style={shared.card}>
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

            return (
              <View key={provider.id}>
                {index > 0 && <Divider />}
                <View style={styles.healthRow}>
                  <View style={styles.flex}>
                    <Text style={shared.bodyStrong}>{provider.label}</Text>
                    <Text style={shared.dim} numberOfLines={2}>
                      {!configured
                        ? 'No key configured'
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
                      configured && !cooling ? styles.statusDotOk : styles.statusDotOff,
                    ]}
                  >
                    {configured && !cooling && (
                      <Icon name="check" size={10} color={colors.onFill} />
                    )}
                  </View>
                </View>
              </View>
            );
          })}
        </View>

        {/* --------------------------------- sweep ------------------------------- */}
        <View style={shared.card}>
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
            {listSourceLabels().map((source) => (
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
        </View>

        {/* ------------------------------- behaviour ----------------------------- */}
        <View style={shared.card}>
          <SectionHeader title="Agent behaviour" />

          <Text style={shared.label}>Max steps per run</Text>
          <View style={styles.chipRow}>
            {[10, 15, 25, 40].map((value) => (
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
        </View>

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
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.lg,
    paddingVertical: space.sm,
  },
  spacer: { height: space.lg },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg },
  bottomSpace: { height: space.xxl },
});
