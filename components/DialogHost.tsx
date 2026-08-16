import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, BackHandler, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { DialogRequest, registerDialogHandler } from '@/services/dialog';
import { Button } from './ui';
import { colors, elevation, radius, space, type } from './theme';

interface Pending {
  request: DialogRequest;
  resolve: (index: number) => void;
}

/**
 * Renders app-styled dialogs in place of the OS alert. Mounted once at the app
 * root; requests arrive through the dialog service.
 *
 * Requests are queued rather than dropped, so two near-simultaneous prompts
 * (a failed sweep plus a failed run, say) both get shown.
 */
export default function DialogHost() {
  const [current, setCurrent] = useState<Pending | null>(null);
  const queue = useRef<Pending[]>([]);
  const anim = useRef(new Animated.Value(0)).current;

  const showNext = useCallback(() => {
    const next = queue.current.shift() ?? null;
    setCurrent(next);
  }, []);

  useEffect(() => {
    registerDialogHandler(
      (request) =>
        new Promise<number>((resolve) => {
          const pending = { request, resolve };
          setCurrent((active) => {
            if (active) {
              queue.current.push(pending);
              return active;
            }
            return pending;
          });
        })
    );
    return () => registerDialogHandler(null);
  }, []);

  useEffect(() => {
    anim.setValue(0);
    if (current) {
      Animated.spring(anim, {
        toValue: 1,
        useNativeDriver: true,
        speed: 18,
        bounciness: 6,
      }).start();
    }
  }, [current, anim]);

  const choose = useCallback(
    (index: number) => {
      current?.resolve(index);
      showNext();
    },
    [current, showNext]
  );

  // Android back button picks the cancel action, matching platform expectations.
  useEffect(() => {
    if (!current) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const cancelIndex = current.request.actions.findIndex((a) => a.cancel);
      if (cancelIndex >= 0) choose(cancelIndex);
      return true; // always swallow: the dialog is modal
    });
    return () => subscription.remove();
  }, [current, choose]);

  if (!current) return null;

  const { title, message, actions } = current.request;
  const stacked = actions.length > 2;

  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent onRequestClose={() => {}}>
      <View style={styles.scrim}>
        <Animated.View
          style={[
            styles.card,
            {
              opacity: anim,
              transform: [
                { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
              ],
            },
          ]}
        >
          <Text style={styles.title}>{title}</Text>
          {!!message && <Text style={styles.message}>{message}</Text>}

          <View style={[styles.actions, stacked && styles.actionsStacked]}>
            {actions.map((action, index) => (
              <Button
                key={`${action.label}-${index}`}
                label={action.label}
                variant={action.variant ?? 'secondary'}
                onPress={() => choose(index)}
                style={stacked ? undefined : styles.action}
              />
            ))}
          </View>
        </Animated.View>

        {/* Blocks taps behind the card without dismissing — dialogs are modal. */}
        <Pressable style={styles.backdrop} onPress={() => {}} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(10,10,10,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  backdrop: { ...StyleSheet.absoluteFillObject, zIndex: -1 },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.xl,
    ...elevation.raised,
  },
  title: { ...type.h1, fontSize: 19, color: colors.text },
  message: { ...type.body, color: colors.textDim, lineHeight: 21, marginTop: space.sm },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.xl },
  actionsStacked: { flexDirection: 'column' },
  action: { flex: 1 },
});
