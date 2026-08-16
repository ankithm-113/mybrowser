import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Icon from '@/components/Icon';
import { colors, radius, shared, space, switchColors, type } from '@/components/theme';
import { Badge, Button, Divider, Field, Meter, SectionHeader } from '@/components/ui';
import {
  EMPTY_VAULT,
  blankProject,
  blankWorkEntry,
  deleteDocument,
  importDocument,
  loadVault,
  saveVault,
  setPrimaryResume,
  vaultCompleteness,
} from '@/services/knowledgeVault';
import { KnowledgeVault, ProjectEntry, UserProfile, WorkHistoryEntry } from '@/types';

type ListField = 'skills' | 'otherLinks' | 'preferredRoles' | 'preferredLocations';

export default function VaultScreen() {
  const [vault, setVault] = useState<KnowledgeVault>(EMPTY_VAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    loadVault().then((v) => {
      setVault(v);
      setLoading(false);
    });
  }, []);

  const persist = useCallback(async (next: KnowledgeVault) => {
    setVault(next);
    setSaving(true);
    await saveVault(next);
    setSaving(false);
  }, []);

  const setProfile = useCallback(
    <K extends keyof UserProfile>(key: K, value: UserProfile[K]) => {
      setVault((v) => ({ ...v, profile: { ...v.profile, [key]: value } }));
    },
    []
  );

  const setListField = useCallback(
    (key: ListField, raw: string) => {
      setProfile(
        key,
        raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
    },
    [setProfile]
  );

  const onImport = useCallback(async (kind: 'resume' | 'cover_letter' | 'other') => {
    setImporting(true);
    try {
      const result = await importDocument(kind);
      if (!result.cancelled) {
        setVault(await loadVault());
        if (result.warning) Alert.alert('Imported with a caveat', result.warning);
        else if (result.document) {
          Alert.alert(
            'Imported',
            `${result.document.name} — extracted ${result.document.extractedText.length} characters of text.`
          );
        }
      }
    } catch (err) {
      Alert.alert('Import failed', err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }, []);

  const onDeleteDoc = useCallback((id: string, name: string) => {
    Alert.alert('Remove document', `Delete "${name}" from the vault?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteDocument(id);
          setVault(await loadVault());
        },
      },
    ]);
  }, []);

  if (loading) {
    return (
      <SafeAreaView style={[shared.screen, styles.center]}>
        <ActivityIndicator color={colors.text} />
      </SafeAreaView>
    );
  }

  const completeness = vaultCompleteness(vault);
  const p = vault.profile;

  const field = (
    label: string,
    key: keyof UserProfile,
    options?: { multiline?: boolean; keyboardType?: 'default' | 'email-address' | 'phone-pad' }
  ) => (
    <Field
      key={String(key)}
      label={label}
      value={String(p[key] ?? '')}
      onChangeText={(t) => setProfile(key, t as never)}
      placeholder={label}
      multiline={options?.multiline}
      keyboardType={options?.keyboardType ?? 'default'}
      autoCapitalize={key === 'email' ? 'none' : 'sentences'}
      onBlur={() => persist(vault)}
    />
  );

  const listInput = (label: string, key: ListField, placeholder: string) => (
    <Field
      label={label}
      value={(p[key] as string[]).join(', ')}
      onChangeText={(t) => setListField(key, t)}
      placeholder={placeholder}
      hint="Comma separated"
      autoCapitalize="none"
      onBlur={() => persist(vault)}
    />
  );

  const toggle = (label: string, key: keyof UserProfile) => (
    <View style={styles.toggleRow}>
      <Text style={shared.body}>{label}</Text>
      <Switch
        value={!!p[key]}
        onValueChange={(v) => void persist({ ...vault, profile: { ...vault.profile, [key]: v } })}
        {...switchColors}
      />
    </View>
  );

  const updateWork = (id: string, patch: Partial<WorkHistoryEntry>) =>
    setVault((v) => ({
      ...v,
      workHistory: v.workHistory.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    }));

  const updateProject = (id: string, patch: Partial<ProjectEntry>) =>
    setVault((v) => ({
      ...v,
      projects: v.projects.map((pr) => (pr.id === id ? { ...pr, ...patch } : pr)),
    }));

  return (
    <SafeAreaView style={shared.screen} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={shared.display}>Vault</Text>
          <Text style={shared.dim}>
            Encrypted on-device and fed to the agent whenever a form needs your details.
            {saving ? '  Saving...' : ''}
          </Text>
        </View>

        <View style={shared.card}>
          <View style={styles.meterHeader}>
            <Text style={shared.h2}>Profile completeness</Text>
            <Text style={styles.meterValue}>{completeness.percent}%</Text>
          </View>
          <Meter percent={completeness.percent} />
          {completeness.missing.length > 0 && (
            <Text style={[shared.dim, styles.meterNote]}>
              Missing: {completeness.missing.join(', ')}
            </Text>
          )}
        </View>

        {/* ------------------------------ documents ----------------------------- */}
        <View style={shared.card}>
          <SectionHeader title="Documents" />
          <Text style={[shared.dim, styles.intro]}>
            PDF, DOCX, TXT and MD are parsed on-device — no upload, no OCR service.
          </Text>

          <View style={styles.buttonRow}>
            <Button
              label="Resume"
              icon="plus"
              onPress={() => onImport('resume')}
              disabled={importing}
              style={styles.flex}
              small
            />
            <Button
              label="Cover letter"
              icon="plus"
              variant="secondary"
              onPress={() => onImport('cover_letter')}
              disabled={importing}
              style={styles.flex}
              small
            />
          </View>

          {vault.documents.length === 0 ? (
            <Text style={shared.dim}>No documents yet.</Text>
          ) : (
            vault.documents.map((doc, index) => (
              <View key={doc.id}>
                {index > 0 && <Divider />}
                <View style={styles.docRow}>
                  <Icon name="document" size={20} color={colors.textDim} />
                  <View style={styles.flex}>
                    <View style={styles.docTitleRow}>
                      <Text style={shared.bodyStrong} numberOfLines={1}>
                        {doc.name}
                      </Text>
                      {doc.isPrimaryResume && <Badge label="Primary" filled />}
                    </View>
                    <Text style={shared.dim}>
                      {doc.kind.replace('_', ' ')} · {(doc.sizeBytes / 1024).toFixed(0)} KB ·{' '}
                      {doc.extractionOk
                        ? `${doc.extractedText.length} chars extracted`
                        : 'text not extractable'}
                    </Text>
                    <View style={styles.docActions}>
                      {!doc.isPrimaryResume && doc.kind === 'resume' && (
                        <Pressable
                          onPress={async () => {
                            await setPrimaryResume(doc.id);
                            setVault(await loadVault());
                          }}
                          hitSlop={8}
                        >
                          <Text style={styles.link}>Set primary</Text>
                        </Pressable>
                      )}
                      <Pressable onPress={() => onDeleteDoc(doc.id, doc.name)} hitSlop={8}>
                        <Text style={styles.linkMuted}>Delete</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              </View>
            ))
          )}
        </View>

        {/* ------------------------------- identity ----------------------------- */}
        <View style={shared.card}>
          <SectionHeader title="Contact & identity" />
          {field('Full name', 'fullName')}
          {field('Email', 'email', { keyboardType: 'email-address' })}
          {field('Phone', 'phone', { keyboardType: 'phone-pad' })}
          {field('Location', 'location')}
          {field('Headline', 'headline')}
          {field('Professional summary', 'summary', { multiline: true })}
        </View>

        <View style={shared.card}>
          <SectionHeader title="Links" />
          {field('GitHub URL', 'githubUrl')}
          {field('LinkedIn URL', 'linkedinUrl')}
          {field('Portfolio URL', 'portfolioUrl')}
          {listInput('Other links', 'otherLinks', 'https://..., https://...')}
        </View>

        <View style={shared.card}>
          <SectionHeader title="Job preferences" />
          {listInput('Skills', 'skills', 'React Native, TypeScript, Node')}
          {listInput('Preferred roles', 'preferredRoles', 'Software Developer, Mobile Engineer')}
          {listInput('Preferred locations', 'preferredLocations', 'Remote, Bengaluru')}
          {field('Years of experience', 'yearsExperience')}
          {field('Current CTC', 'currentCTC')}
          {field('Expected CTC', 'expectedCTC')}
          {field('Notice period', 'noticePeriod')}
          {field('Work authorization', 'workAuthorization')}
          <Divider />
          <View style={styles.spacer} />
          {toggle('Needs visa sponsorship', 'requiresSponsorship')}
          {toggle('Willing to relocate', 'willingToRelocate')}
          {toggle('Remote roles only', 'remoteOnly')}
        </View>

        {/* ----------------------------- work history --------------------------- */}
        <View style={shared.card}>
          <SectionHeader
            title="Work history"
            action="Add"
            onAction={() =>
              persist({ ...vault, workHistory: [...vault.workHistory, blankWorkEntry()] })
            }
          />

          {vault.workHistory.length === 0 && <Text style={shared.dim}>No entries yet.</Text>}

          {vault.workHistory.map((w) => (
            <View key={w.id} style={styles.subCard}>
              <Field
                value={w.role}
                onChangeText={(t) => updateWork(w.id, { role: t })}
                placeholder="Role"
                onBlur={() => persist(vault)}
              />
              <Field
                value={w.company}
                onChangeText={(t) => updateWork(w.id, { company: t })}
                placeholder="Company"
                onBlur={() => persist(vault)}
              />
              <View style={styles.inlineRow}>
                <Field
                  value={w.start}
                  onChangeText={(t) => updateWork(w.id, { start: t })}
                  placeholder="Start"
                  style={styles.flex}
                  onBlur={() => persist(vault)}
                />
                <Field
                  value={w.end}
                  onChangeText={(t) => updateWork(w.id, { end: t })}
                  placeholder="End or Present"
                  style={styles.flex}
                  onBlur={() => persist(vault)}
                />
              </View>
              <Field
                value={w.description}
                onChangeText={(t) => updateWork(w.id, { description: t })}
                placeholder="What you did, with impact"
                multiline
                onBlur={() => persist(vault)}
              />
              <Pressable
                onPress={() =>
                  persist({
                    ...vault,
                    workHistory: vault.workHistory.filter((x) => x.id !== w.id),
                  })
                }
                hitSlop={8}
              >
                <Text style={styles.linkMuted}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>

        {/* ------------------------------- projects ----------------------------- */}
        <View style={shared.card}>
          <SectionHeader
            title="Projects"
            action="Add"
            onAction={() => persist({ ...vault, projects: [...vault.projects, blankProject()] })}
          />

          {vault.projects.length === 0 && <Text style={shared.dim}>No projects yet.</Text>}

          {vault.projects.map((pr) => (
            <View key={pr.id} style={styles.subCard}>
              <Field
                value={pr.name}
                onChangeText={(t) => updateProject(pr.id, { name: t })}
                placeholder="Project name"
                onBlur={() => persist(vault)}
              />
              <Field
                value={pr.url}
                onChangeText={(t) => updateProject(pr.id, { url: t })}
                placeholder="Link (repo or live demo)"
                autoCapitalize="none"
                onBlur={() => persist(vault)}
              />
              <Field
                value={pr.stack}
                onChangeText={(t) => updateProject(pr.id, { stack: t })}
                placeholder="Stack"
                onBlur={() => persist(vault)}
              />
              <Field
                value={pr.description}
                onChangeText={(t) => updateProject(pr.id, { description: t })}
                placeholder="One or two lines about it"
                multiline
                onBlur={() => persist(vault)}
              />
              <Pressable
                onPress={() =>
                  persist({ ...vault, projects: vault.projects.filter((x) => x.id !== pr.id) })
                }
                hitSlop={8}
              >
                <Text style={styles.linkMuted}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>

        <View style={shared.card}>
          <SectionHeader title="Notes for the agent" />
          <Text style={[shared.dim, styles.intro]}>
            Answers to common application questions, why you are looking, references, anything else.
          </Text>
          <Field
            value={vault.notes}
            onChangeText={(t) => setVault((v) => ({ ...v, notes: t }))}
            placeholder="Notes"
            multiline
            style={styles.notes}
            onBlur={() => persist(vault)}
          />
        </View>

        <Button label="Save vault" onPress={() => persist(vault)} loading={saving} />
        <View style={styles.bottomSpace} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: space.lg, paddingTop: space.sm },
  header: { marginBottom: space.lg, gap: space.sm },
  flex: { flex: 1 },
  intro: { marginBottom: space.md },

  meterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.md,
  },
  meterValue: { ...type.h1, color: colors.text },
  meterNote: { marginTop: space.md },

  buttonRow: { flexDirection: 'row', gap: space.sm, marginBottom: space.lg },

  docRow: { flexDirection: 'row', gap: space.md, paddingVertical: space.md },
  docTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: 2 },
  docActions: { flexDirection: 'row', gap: space.lg, marginTop: space.sm },
  link: { ...type.small, fontWeight: '700', color: colors.text },
  linkMuted: { ...type.small, fontWeight: '700', color: colors.textDim },

  subCard: {
    backgroundColor: colors.sunkenAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    marginBottom: space.md,
  },
  inlineRow: { flexDirection: 'row', gap: space.sm },
  notes: { minHeight: 120 },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  spacer: { height: space.md },
  bottomSpace: { height: space.xxl },
});
