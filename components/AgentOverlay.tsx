import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { AgentStatus } from '@/types';
import Glass from './Glass';
import Icon from './Icon';
import { colors, elevation, radius, space, type } from './theme';

interface Props {
  status: AgentStatus;
  onStop: () => void;
  lastThought?: string;
  /** Present only while the run is parked waiting for the user. */
  onResume?: () => void;
}

/** Floating status card shown over the WebView while a run is in flight. */
export default function AgentOverlay({ status, onStop, lastThought, onResume }: Props) {
  const slide = useRef(new Animated.Value(0)).current;
  const visible = status.phase !== 'idle';

  useEffect(() => {
    Animated.spring(slide, {
      toValue: visible ? 1 : 0,
      useNativeDriver: true,
      speed: 14,
      bounciness: 4,
    }).start();
  }, [visible, slide]);

  if (!visible) return null;

  const busy = !['done', 'error', 'waiting_user'].includes(status.phase);
  const progress = status.maxSteps > 0 ? Math.min(1, status.step / status.maxSteps) : 0;

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
          <Text style={styles.message} numberOfLines={2}>
            {status.message}
          </Text>
          <Pressable
            onPress={onStop}
            hitSlop={10}
            style={({ pressed }) => [styles.stop, pressed && styles.stopPressed]}
          >
            <Text style={styles.stopText}>{busy ? 'Stop' : 'Close'}</Text>
          </Pressable>
        </View>

        {!!lastThought && (
          <Text style={styles.thought} numberOfLines={3}>
            {lastThought}
          </Text>
        )}

        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>

          {/* Parked: the loop is waiting on this button, not on a timer. */}
          {onResume && (
            <Pressable
              onPress={onResume}
              style={({ pressed }) => [styles.resume, pressed && styles.resumePressed]}
            >
              <Text style={styles.resumeText}>Resume Agent</Text>
            </Pressable>
          )}

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
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  statusDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  message: { ...type.bodyStrong, color: colors.text, flex: 1 },
  thought: { ...type.small, color: colors.textDim, marginTop: space.md, lineHeight: 18 },
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
