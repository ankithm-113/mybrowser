import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { AgentRunLogEntry, AgentStatus } from '@/types';
import Glass from './Glass';
import Icon from './Icon';
import { colors, elevation, radius, space, type } from './theme';

interface Props {
  status: AgentStatus;
  onStop: () => void;
  lastThought?: string;
  /** Full step history, shown when the card is expanded. */
  runLog?: AgentRunLogEntry[];
  /** Present only while the run is parked waiting for the user. */
  onResume?: () => void;
}

/** Rough character count that fits the collapsed card without clipping. */
const COLLAPSED_CHARS = 90;

/**
 * Floating status card shown over the WebView while a run is in flight.
 *
 * The agent's answers land here, and they are routinely longer than two lines,
 * so the card expands into a scrollable transcript with selectable text —
 * otherwise the only way to read a reply was the Metro terminal.
 */
export default function AgentOverlay({ status, onStop, lastThought, runLog, onResume }: Props) {
  const slide = useRef(new Animated.Value(0)).current;
  const [expanded, setExpanded] = useState(false);
  const visible = status.phase !== 'idle';

  useEffect(() => {
    Animated.spring(slide, {
      toValue: visible ? 1 : 0,
      useNativeDriver: true,
      speed: 14,
      bounciness: 4,
    }).start();
  }, [visible, slide]);

  // A finished run's summary is the payload the user actually asked for.
  const finished = status.phase === 'done' || status.phase === 'error';
  useEffect(() => {
    if (finished && status.message.length > COLLAPSED_CHARS) setExpanded(true);
  }, [finished, status.message]);

  if (!visible) return null;

  const busy = !['done', 'error', 'waiting_user'].includes(status.phase);
  const progress = status.maxSteps > 0 ? Math.min(1, status.step / status.maxSteps) : 0;
  const hasMore =
    status.message.length > COLLAPSED_CHARS ||
    (lastThought?.length ?? 0) > COLLAPSED_CHARS ||
    (runLog?.length ?? 0) > 0;

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((v) => !v);
  };

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <Animated.View
        style={[
          styles.cardShadow,
          {
            opacity: slide,
            transform: [
              { translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
            ],
          },
        ]}
      >
        <Glass tone="light" intensity={70} radiusSize={radius.lg} style={styles.card}>
          <View style={styles.headerRow}>
            {busy ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <View style={styles.statusDot}>
                <Icon
                  name={status.phase === 'done' ? 'check' : 'close'}
                  size={11}
                  color={colors.onFill}
                />
              </View>
            )}

            <Pressable style={styles.messagePress} onPress={hasMore ? toggle : undefined}>
              <Text
                style={styles.message}
                numberOfLines={expanded ? undefined : 2}
                selectable={expanded}
              >
                {status.message}
              </Text>
            </Pressable>

            <Pressable
              onPress={onStop}
              hitSlop={10}
              style={({ pressed }) => [styles.stop, pressed && styles.stopPressed]}
            >
              <Text style={styles.stopText}>{busy ? 'Stop' : 'Close'}</Text>
            </Pressable>
          </View>

          {expanded ? (
            <ScrollView
              style={styles.transcript}
              contentContainerStyle={styles.transcriptContent}
              showsVerticalScrollIndicator
              nestedScrollEnabled
            >
              {!!lastThought && (
                <>
                  <Text style={styles.sectionLabel}>Current thinking</Text>
                  <Text style={styles.body} selectable>
                    {lastThought}
                  </Text>
                </>
              )}

              {!!runLog?.length && (
                <>
                  <Text style={[styles.sectionLabel, styles.sectionSpaced]}>Steps</Text>
                  {runLog.map((entry) => (
                    <View key={`${entry.step}-${entry.at}`} style={styles.stepRow}>
                      <Text style={styles.stepNumber}>{entry.step}</Text>
                      <View style={styles.stepBody}>
                        <Text style={styles.body} selectable>
                          {entry.thought}
                        </Text>
                        <Text style={styles.stepActions} selectable>
                          {entry.actions
                            .map((a) => `${a.type}${a.targetAgentId ? ` ${a.targetAgentId}` : ''}`)
                            .join(', ')}
                        </Text>
                      </View>
                    </View>
                  ))}
                </>
              )}
            </ScrollView>
          ) : (
            !!lastThought && (
              <Text style={styles.thought} numberOfLines={2}>
                {lastThought}
              </Text>
            )
          )}

          {hasMore && (
            <Pressable
              onPress={toggle}
              style={({ pressed }) => [styles.expandRow, pressed && styles.expandRowPressed]}
            >
              <Text style={styles.expandText}>
                {expanded ? 'Show less' : 'Read full reply'}
              </Text>
            </Pressable>
          )}

          {/* Parked: the loop is waiting on this button, not on a timer. */}
          {onResume && (
            <Pressable
              onPress={onResume}
              style={({ pressed }) => [styles.resume, pressed && styles.resumePressed]}
            >
              <Text style={styles.resumeText}>Resume Agent</Text>
            </Pressable>
          )}

          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
          </View>

          <Text style={styles.meta}>
            Step {status.step} of {status.maxSteps}
            {status.provider ? `  ·  ${status.provider}` : ''}
          </Text>
        </Glass>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: space.md, right: space.md, bottom: space.lg },
  cardShadow: { borderRadius: radius.lg, ...elevation.raised },
  card: { padding: space.lg },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  statusDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    marginTop: 2,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messagePress: { flex: 1 },
  message: { ...type.bodyStrong, color: colors.text, lineHeight: 20 },
  thought: { ...type.small, color: colors.textDim, marginTop: space.md, lineHeight: 18 },

  /** Capped so the card can never swallow the whole browser viewport. */
  transcript: { maxHeight: 260, marginTop: space.md },
  transcriptContent: { paddingBottom: space.sm },
  sectionLabel: {
    ...type.label,
    color: colors.textFaint,
    textTransform: 'uppercase',
    marginBottom: space.xs,
  },
  sectionSpaced: { marginTop: space.lg },
  body: { ...type.small, color: colors.text, lineHeight: 18 },
  stepRow: { flexDirection: 'row', gap: space.sm, marginBottom: space.md },
  stepNumber: {
    ...type.micro,
    color: colors.textFaint,
    minWidth: 16,
    textAlign: 'right',
    marginTop: 2,
  },
  stepBody: { flex: 1 },
  stepActions: { ...type.micro, fontWeight: '400', color: colors.textDim, marginTop: 2 },

  expandRow: {
    marginTop: space.md,
    paddingVertical: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  expandRowPressed: { backgroundColor: colors.sunken },
  expandText: { ...type.small, fontWeight: '700', color: colors.text },

  progressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.sunken,
    overflow: 'hidden',
    marginTop: space.md,
  },
  progressFill: { height: 3, backgroundColor: colors.fill },
  meta: { ...type.micro, color: colors.textFaint, marginTop: space.sm },
  stop: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  stopPressed: { backgroundColor: colors.sunken },
  stopText: { ...type.small, fontWeight: '700', color: colors.text },
  resume: {
    marginTop: space.md,
    backgroundColor: colors.fill,
    borderRadius: radius.sm,
    paddingVertical: 11,
    alignItems: 'center',
  },
  resumePressed: { backgroundColor: colors.fillPressed },
  resumeText: { ...type.bodyStrong, color: colors.onFill },
});
