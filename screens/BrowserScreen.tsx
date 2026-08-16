import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Browser, { BrowserHandle } from '@/components/Browser';
import Icon from '@/components/Icon';
import { colors, radius, space, type } from '@/components/theme';
import { AgentRequest, registerAgentHandler } from '@/services/agentBus';
import { planTask } from '@/services/agentLoop';
import { alert, confirm } from '@/services/dialog';
import { isVoiceAvailable, startListening, VoiceSession } from '@/services/voice';

/**
 * The agent's home: a command bar over the live browser.
 * Typed or spoken commands are planned into a task + start URL, then run.
 */
export default function BrowserScreen() {
  const browserRef = useRef<BrowserHandle>(null);
  const voiceRef = useRef<VoiceSession | null>(null);

  const [command, setCommand] = useState('');
  const [listening, setListening] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [hint, setHint] = useState('');

  const runRequest = useCallback(async (request: AgentRequest) => {
    return (
      (await browserRef.current?.runTask(request.task, request.url)) ?? {
        ok: false,
        summary: 'Browser is not ready.',
        steps: 0,
        log: [],
      }
    );
  }, []);

  useEffect(() => {
    registerAgentHandler(runRequest);
    return () => registerAgentHandler(null);
  }, [runRequest]);

  const launch = useCallback(async (rawCommand: string) => {
    const text = rawCommand.trim();
    if (!text) return;
    if (browserRef.current?.isRunning()) {
      void alert('Agent busy', 'Stop the current run before starting a new one.');
      return;
    }

    setPlanning(true);
    setHint('Planning the task...');
    try {
      const plan = await planTask(text);
      setPlanning(false);

      if (plan.needsConfirmation) {
        const approved = await confirm({
          title: 'Confirm this task',
          message:
            `${plan.task}\n\nStarting at: ${plan.startUrl}\n\n` +
            'This task may spend money or send something on your behalf.',
          confirmLabel: 'Run it',
        });
        if (!approved) return;
      }

      setHint(plan.note || '');
      setCommand('');
      void browserRef.current?.runTask(plan.task, plan.startUrl);
    } catch (err) {
      setPlanning(false);
      setHint('');
      void alert('Could not plan the task', err instanceof Error ? err.message : String(err));
    }
  }, []);

  const toggleVoice = useCallback(async () => {
    if (listening) {
      voiceRef.current?.stop();
      return;
    }
    if (!isVoiceAvailable()) {
      void alert(
        'Voice unavailable',
        'Speech recognition needs a development build (it is not available in Expo Go). ' +
          'Run "npx expo run:android" or "run:ios", then try again.'
      );
      return;
    }

    setListening(true);
    setHint('Listening...');
    voiceRef.current = await startListening(
      (transcript, isFinal) => {
        setCommand(transcript);
        if (isFinal) {
          setListening(false);
          void launch(transcript);
        }
      },
      (error) => {
        setListening(false);
        voiceRef.current = null;
        if (error) {
          setHint('');
          void alert('Voice error', error);
        }
      }
    );
  }, [listening, launch]);

  const canRun = command.trim().length > 0 && !planning;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.commandBar}>
        <View style={styles.inputWrap}>
          <TextInput
            style={styles.input}
            value={command}
            onChangeText={setCommand}
            placeholder="Tell the agent what to do"
            placeholderTextColor={colors.textFaint}
            onSubmitEditing={() => launch(command)}
            returnKeyType="go"
          />
          <Pressable
            onPress={toggleVoice}
            hitSlop={6}
            accessibilityLabel={listening ? 'Stop listening' : 'Speak a command'}
            style={({ pressed }) => [
              styles.micButton,
              listening && styles.micButtonActive,
              pressed && styles.micButtonPressed,
            ]}
          >
            <Icon
              name={listening ? 'stop' : 'mic'}
              size={19}
              color={listening ? colors.onFill : colors.text}
            />
          </Pressable>
        </View>

        <Pressable
          onPress={() => launch(command)}
          disabled={!canRun}
          accessibilityLabel="Run task"
          style={({ pressed }) => [
            styles.runButton,
            !canRun && styles.runButtonDisabled,
            pressed && canRun && styles.runButtonPressed,
          ]}
        >
          {planning ? (
            <ActivityIndicator size="small" color={colors.onFill} />
          ) : (
            <Text style={[styles.runLabel, !canRun && styles.runLabelDisabled]}>Run</Text>
          )}
        </Pressable>
      </View>

      {!!hint && (
        <Text style={styles.hint} numberOfLines={2}>
          {hint}
        </Text>
      )}

      <Browser ref={browserRef} onRunFinished={(result) => setHint(result.summary)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  commandBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    backgroundColor: colors.bg,
  },
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.sunken,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingRight: space.xs,
  },
  input: {
    flex: 1,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontSize: 14,
  },
  micButton: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonActive: { backgroundColor: colors.fill, borderColor: colors.fill },
  micButtonPressed: { backgroundColor: colors.sunken },

  /** Solid black pill — the one unmistakable primary action on the screen. */
  runButton: {
    minWidth: 72,
    height: 46,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  runButtonPressed: { backgroundColor: colors.fillPressed },
  runButtonDisabled: { backgroundColor: colors.fillDisabled },
  runLabel: { ...type.bodyStrong, color: colors.onFill, fontSize: 15 },
  runLabelDisabled: { color: colors.surface },

  hint: {
    ...type.small,
    color: colors.textDim,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
});
