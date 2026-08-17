import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { dispatch } from '@/services/agentBus';
import { planTask } from '@/services/agentLoop';
import { alert, confirm } from '@/services/dialog';
import { executor } from '@/services/executor';
import { isVoiceAvailable, startListening, VoiceSession } from '@/services/voice';
import Glass from './Glass';
import Icon from './Icon';
import { colors, elevation, radius, space, type } from './theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Switches to the Agent tab so the run is visible once it starts. */
  onNavigateToAgent: () => void;
}

const SUGGESTIONS = [
  'Find remote React Native jobs posted this week',
  'Summarise this page',
  'Fill this form with my details',
];

/**
 * The agent's command surface, opened from the hero button in the tab bar.
 *
 * It lives in a sheet rather than a permanent bar at the top of the browser so
 * the WebView gets the full screen; the input is one tap away instead of
 * always consuming a row.
 */
export default function AgentSheet({ visible, onClose, onNavigateToAgent }: Props) {
  const [command, setCommand] = useState('');
  const [listening, setListening] = useState(false);
  const [planning, setPlanning] = useState(false);
  const voiceRef = useRef<VoiceSession | null>(null);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: visible ? 280 : 180,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, anim]);

  const close = useCallback(() => {
    voiceRef.current?.stop();
    setListening(false);
    onClose();
  }, [onClose]);

  const run = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;

      setPlanning(true);
      try {
        // What the user is looking at right now, so "fill this form" resolves
        // to the open page instead of a web search for those words.
        const open = executor.latestSnapshot;
        const plan = await planTask(text, { url: open?.url, title: open?.title });
        setPlanning(false);

        if (plan.needsConfirmation) {
          const approved = await confirm({
            title: 'Confirm this task',
            message:
              `${plan.task}\n\n${
                plan.startUrl ? `Starting at: ${plan.startUrl}` : 'On the page you have open'
              }\n\n` +
              'This task may spend money or send something on your behalf.',
            confirmLabel: 'Run it',
          });
          if (!approved) return;
        }

        setCommand('');
        close();
        onNavigateToAgent();
        void dispatch({ task: plan.task, url: plan.startUrl });
      } catch (err) {
        setPlanning(false);
        void alert('Could not plan the task', err instanceof Error ? err.message : String(err));
      }
    },
    [close, onNavigateToAgent]
  );

  const toggleVoice = useCallback(async () => {
    if (listening) {
      voiceRef.current?.stop();
      return;
    }
    if (!isVoiceAvailable()) {
      void alert(
        'Voice unavailable',
        'Speech recognition needs a development build. Run "npx expo run:android", then try again.'
      );
      return;
    }

    setListening(true);
    voiceRef.current = await startListening(
      (transcript, isFinal) => {
        setCommand(transcript);
        if (isFinal) {
          setListening(false);
          void run(transcript);
        }
      },
      (error) => {
        setListening(false);
        voiceRef.current = null;
        if (error) void alert('Voice error', error);
      }
    );
  }, [listening, run]);

  const canRun = command.trim().length > 0 && !planning;

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={close}>
      {/* The scrim is absolute, but the sheet itself must stay in normal flow —
          an absolutely positioned child ignores KeyboardAvoidingView entirely,
          which is why the input used to sit behind the keyboard. */}
      <Animated.View style={[styles.scrim, { opacity: anim }]}>
        <Pressable style={styles.fill} onPress={close} accessibilityLabel="Close" />
      </Animated.View>

      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
        pointerEvents="box-none"
      >

        <Animated.View
          style={[
            styles.sheetWrap,
            {
              transform: [
                { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [400, 0] }) },
              ],
            },
          ]}
        >
          <Glass tone="light" intensity={85} radiusSize={radius.xl} style={styles.sheet}>
            <View style={styles.grabber} />

            <Text style={styles.title}>What should the agent do?</Text>

            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={command}
                onChangeText={setCommand}
                placeholder="Book a table, apply to this job, fill this form..."
                placeholderTextColor={colors.textFaint}
                onSubmitEditing={() => run(command)}
                returnKeyType="go"
                autoFocus
                multiline
              />
            </View>

            {!command.trim() && (
              <View style={styles.suggestions}>
                {SUGGESTIONS.map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => setCommand(s)}
                    style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
                  >
                    <Text style={styles.suggestionText} numberOfLines={1}>
                      {s}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            <View style={styles.actions}>
              <Pressable
                onPress={toggleVoice}
                accessibilityLabel={listening ? 'Stop listening' : 'Speak a command'}
                style={({ pressed }) => [
                  styles.micButton,
                  listening && styles.micButtonActive,
                  pressed && styles.micButtonPressed,
                ]}
              >
                <Icon
                  name={listening ? 'stop' : 'mic'}
                  size={20}
                  color={listening ? colors.onFill : colors.text}
                />
              </Pressable>

              <Pressable
                onPress={() => run(command)}
                disabled={!canRun}
                style={({ pressed }) => [
                  styles.runButton,
                  !canRun && styles.runButtonDisabled,
                  pressed && canRun && styles.runButtonPressed,
                ]}
              >
                {planning ? (
                  <ActivityIndicator size="small" color={colors.onFill} />
                ) : (
                  <Text style={[styles.runLabel, !canRun && styles.runLabelDisabled]}>
                    {listening ? 'Listening...' : 'Run'}
                  </Text>
                )}
              </Pressable>
            </View>
          </Glass>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,10,10,0.42)' },
  /** Anchors the sheet to the bottom while leaving it in flow for the KAV. */
  keyboardView: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: {
    marginHorizontal: space.sm,
    marginBottom: space.sm,
    borderRadius: radius.xl,
    ...elevation.raised,
  },
  sheet: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xl },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: space.lg,
  },
  title: { ...type.h2, color: colors.text, marginBottom: space.md },
  inputRow: {
    backgroundColor: colors.sunken,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: {
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: 15,
    minHeight: 76,
    maxHeight: 150,
    textAlignVertical: 'top',
  },
  suggestions: { marginTop: space.md, gap: space.sm },
  suggestion: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: 'transparent',
  },
  suggestionPressed: { backgroundColor: colors.sunken },
  suggestionText: { ...type.small, color: colors.textDim },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.lg },
  micButton: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonActive: { backgroundColor: colors.fill, borderColor: colors.fill },
  micButtonPressed: { backgroundColor: colors.sunken },
  runButton: {
    flex: 1,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  runButtonPressed: { backgroundColor: colors.fillPressed },
  runButtonDisabled: { backgroundColor: colors.fillDisabled },
  runLabel: { ...type.bodyStrong, color: colors.onFill, fontSize: 16 },
  runLabelDisabled: { color: colors.surface },
});
