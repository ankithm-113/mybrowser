import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';

import Icon from '@/components/Icon';
import { TAB_BAR_INSET } from '@/components/layout';
import { colors, radius, shared, space, type } from '@/components/theme';
import { Badge, Button, Chip, EmptyState, GlassCard } from '@/components/ui';
import { dispatch, onRunComplete } from '@/services/agentBus';
import { alert } from '@/services/dialog';
import { getLastSweep, loadJobs, runJobSweep, updateJob } from '@/services/jobScheduler';
import { loadVault } from '@/services/knowledgeVault';
import { JobMatch } from '@/types';

type Filter = 'new' | 'applied' | 'all';

export default function JobReviewScreen() {
  const navigation = useNavigation<any>();
  const [jobs, setJobs] = useState<JobMatch[]>([]);
  const [filter, setFilter] = useState<Filter>('new');
  const [sweeping, setSweeping] = useState(false);
  const [lastSweep, setLastSweep] = useState<{ at: number; matched: number } | null>(null);

  const refresh = useCallback(async () => {
    setJobs(await loadJobs());
    setLastSweep(await getLastSweep());
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribeNav = navigation.addListener('focus', refresh);
    const unsubscribeRun = onRunComplete(async (jobId, result) => {
      await updateJob(jobId, {
        status: result.ok ? 'applied' : 'failed',
        appliedAt: result.ok ? Date.now() : undefined,
        failureReason: result.ok ? undefined : result.summary,
      });
      void refresh();
    });
    return () => {
      unsubscribeNav();
      unsubscribeRun();
    };
  }, [navigation, refresh]);

  const sweep = useCallback(async () => {
    setSweeping(true);
    try {
      const result = await runJobSweep();
      await refresh();
      void alert(
        'Sweep complete',
        `${result.found} new postings seen, ${result.matched} passed your score threshold.` +
          (result.errors.length ? `\n\nSources that failed:\n${result.errors.join('\n')}` : '')
      );
    } catch (err) {
      void alert('Sweep failed', err instanceof Error ? err.message : String(err));
    } finally {
      setSweeping(false);
    }
  }, [refresh]);

  const applyAutonomously = useCallback(
    async (job: JobMatch) => {
      const vault = await loadVault();
      if (!vault.profile.fullName || !vault.profile.email) {
        void alert(
          'Vault incomplete',
          'Add at least your name and email in the Vault tab before auto-applying.'
        );
        return;
      }

      await updateJob(job.id, { status: 'applying' });
      await refresh();
      navigation.navigate('Agent');

      const task =
        `Apply to this job on behalf of the user.\n` +
        `Role: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location}\n` +
        `Posting URL: ${job.url}\n\n` +
        `Find and open the application form. Clicking Apply is only the first step: "Easy Apply" opens a ` +
        `multi-step dialog on the page, while a plain "Apply" hands off to a career portal such as ` +
        `Greenhouse, Lever, Workday or Ashby — in both cases you must complete the form that appears. ` +
        `Fill every field from the user's profile, attach the primary resume to any file upload, and answer ` +
        `screening questions truthfully from the vault.\n\n` +
        `The task is complete ONLY when the site confirms submission (a "thank you", an "application ` +
        `submitted" message, or a reference number). Reaching the form or clicking Apply is not applying. ` +
        `Stop and ask the user if you hit a login wall, a CAPTCHA, or a question the vault cannot answer.`;

      void dispatch({ task, url: job.url, jobId: job.id });
    },
    [navigation, refresh]
  );

  const skip = useCallback(
    async (job: JobMatch) => {
      await updateJob(job.id, { status: 'skipped' });
      void refresh();
    },
    [refresh]
  );

  const visible = jobs.filter((j) => {
    if (filter === 'all') return true;
    if (filter === 'new') return j.status === 'new' || j.status === 'applying';
    return j.status === 'applied' || j.status === 'failed';
  });

  const renderJob = ({ item }: { item: JobMatch }) => {
    const strongMatch = item.matchScore >= 75;

    return (
      <GlassCard>
        <View style={styles.jobHeader}>
          <View style={styles.flex}>
            <Text style={styles.jobTitle} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={shared.dim}>
              {item.company} · {item.location || 'Location not stated'}
            </Text>
          </View>

          {/* Score reads by fill, not colour: strong matches are solid black. */}
          <View style={[styles.scoreBadge, strongMatch && styles.scoreBadgeStrong]}>
            <Text style={[styles.scoreText, strongMatch && styles.scoreTextStrong]}>
              {item.matchScore}
            </Text>
          </View>
        </View>

        {!!item.matchReason && (
          <Text style={styles.reason} numberOfLines={3}>
            {item.matchReason}
          </Text>
        )}

        <View style={styles.metaRow}>
          <Badge
            label={item.status}
            filled={item.status === 'applied' || item.status === 'applying'}
          />
          <Text style={styles.metaText}>
            {item.source} · {new Date(item.foundAt).toLocaleDateString()}
          </Text>
        </View>

        {!!item.failureReason && <Text style={styles.failure}>{item.failureReason}</Text>}

        <View style={styles.actionRow}>
          <Button
            label={item.status === 'applying' ? 'Applying' : 'Apply Autonomously'}
            onPress={() => applyAutonomously(item)}
            disabled={item.status === 'applying'}
            style={styles.flex}
          />
          <Button label="Skip" variant="secondary" onPress={() => skip(item)} />
        </View>

        <Pressable
          onPress={() => {
            navigation.navigate('Agent');
            void dispatch({ task: 'Read this job posting and summarise it.', url: item.url });
          }}
          style={({ pressed }) => [styles.openRow, pressed && styles.openRowPressed]}
          hitSlop={6}
        >
          <Text style={styles.openText}>Open posting in the browser</Text>
          <Icon name="arrowRight" size={14} color={colors.text} />
        </Pressable>
      </GlassCard>
    );
  };

  return (
    <SafeAreaView style={shared.screen} edges={['top']}>
      <View style={styles.header}>
        <Text style={shared.display}>Jobs</Text>
        <Text style={shared.dim}>
          {lastSweep
            ? `Last sweep ${new Date(lastSweep.at).toLocaleString()} · ${lastSweep.matched} matches`
            : 'No sweep has run yet.'}
        </Text>

        <View style={styles.filterRow}>
          <View style={styles.filterChips}>
            {(['new', 'applied', 'all'] as Filter[]).map((f) => (
              <Chip
                key={f}
                label={f === 'new' ? 'To review' : f === 'applied' ? 'Applied' : 'All'}
                selected={filter === f}
                onPress={() => setFilter(f)}
              />
            ))}
          </View>
          <Button label="Sweep" onPress={sweep} loading={sweeping} small />
        </View>
      </View>

      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        renderItem={renderJob}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.text} />
        }
        ListEmptyComponent={
          <EmptyState
            title="Nothing here yet"
            body="Fill in the Vault, set your search queries in Settings, then run a sweep. The scheduled sweep runs nightly on its own."
          />
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm },
  flex: { flex: 1 },

  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    marginTop: space.md,
    marginBottom: space.md,
  },
  filterChips: { flexDirection: 'row', gap: space.sm, flex: 1 },

  list: { paddingHorizontal: space.lg, paddingBottom: TAB_BAR_INSET },

  jobHeader: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  jobTitle: { ...type.h2, color: colors.text, marginBottom: 3 },

  scoreBadge: {
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreBadgeStrong: { backgroundColor: colors.fill, borderColor: colors.fill },
  scoreText: { ...type.bodyStrong, fontSize: 15, color: colors.textDim },
  scoreTextStrong: { color: colors.onFill },

  reason: { ...type.small, color: colors.textDim, lineHeight: 18, marginTop: space.md },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.md,
  },
  metaText: { ...type.micro, fontWeight: '400', color: colors.textFaint },
  failure: { ...type.small, color: colors.text, marginTop: space.sm, fontStyle: 'italic' },

  actionRow: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },

  openRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    marginTop: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
  },
  openRowPressed: { backgroundColor: colors.sunken },
  openText: { ...type.small, fontWeight: '700', color: colors.text },
});
