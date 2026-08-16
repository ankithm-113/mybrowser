import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import Glass from './Glass';
import Icon from './Icon';
import { colors, elevation, radius, space, type } from './theme';

interface Props {
  message: string;
  onDismiss: () => void;
  /** Auto-hide after this many ms. Pass 0 to keep it until dismissed. */
  autoHideMs?: number;
}

/**
 * Bottom status sheet.
 *
 * Messages used to sit inline under the address bar, which pushed the page
 * down and stole reading space at the top of the screen. They now slide up
 * from the bottom over the content instead, and never displace it.
 */
export default function StatusSheet({ message, onDismiss, autoHideMs = 6000 }: Props) {
  const anim = useRef(new Animated.Value(0)).current;
  const visible = !!message;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: visible ? 260 : 180,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();

    if (!visible || !autoHideMs) return undefined;
    const timer = setTimeout(onDismiss, autoHideMs);
    return () => clearTimeout(timer);
  }, [visible, message, autoHideMs, anim, onDismiss]);

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          opacity: anim,
          transform: [
            { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [70, 0] }) },
          ],
        },
      ]}
    >
      <Glass tone="light" intensity={75} radiusSize={radius.lg} style={styles.sheet}>
        <View style={styles.grabber} />
        <View style={styles.row}>
          <Text style={styles.message} numberOfLines={4}>
            {message}
          </Text>
          <Pressable
            onPress={onDismiss}
            hitSlop={10}
            accessibilityLabel="Dismiss message"
            style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
          >
            <Icon name="close" size={12} color={colors.text} />
          </Pressable>
        </View>
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    bottom: space.md,
    borderRadius: radius.lg,
    ...elevation.raised,
  },
  sheet: { paddingHorizontal: space.lg, paddingBottom: space.lg, paddingTop: space.sm },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: space.md,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  message: { ...type.small, color: colors.text, lineHeight: 18, flex: 1 },
  close: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closePressed: { backgroundColor: colors.sunken },
});
