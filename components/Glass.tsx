import React from 'react';
import { Platform, StyleSheet, View, ViewProps, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';

import { palette, radius } from './theme';

/**
 * Frosted-glass surface.
 *
 * Blur alone is not enough to read as glass — it needs a translucent tint on
 * top and a hairline highlight border, which is what gives the material an
 * edge. Kept strictly neutral: the tints are white and ink at low alpha.
 *
 * On Android, expo-blur needs `experimentalBlurMethod` to do a real backdrop
 * blur; without it the view renders as a flat translucent rectangle, so the
 * tint below is doing most of the work there.
 */

export type GlassTone = 'light' | 'dark';

interface GlassProps extends ViewProps {
  tone?: GlassTone;
  /** 0-100. Higher is more frosted. */
  intensity?: number;
  radiusSize?: number;
  /** Hairline border that catches the "edge" of the glass. */
  bordered?: boolean;
  style?: ViewStyle | ViewStyle[];
  children?: React.ReactNode;
}

/**
 * Alphas are deliberately low. On a white app, a heavily tinted "frosted white"
 * surface is indistinguishable from plain white — the blurred content has to
 * stay visible through the material for it to read as glass at all.
 */
const TINT: Record<GlassTone, { overlay: string; border: string; highlight: string }> = {
  // Frosted, very slightly cooler than the page so it separates from white.
  light: {
    overlay: 'rgba(246,246,246,0.58)',
    border: 'rgba(10,10,10,0.16)',
    highlight: 'rgba(255,255,255,0.85)',
  },
  // Smoked glass — translucent enough that content shows through the capsule.
  dark: {
    overlay: 'rgba(10,10,10,0.62)',
    border: 'rgba(255,255,255,0.30)',
    highlight: 'rgba(255,255,255,0.35)',
  },
};

export default function Glass({
  tone = 'light',
  intensity = 40,
  radiusSize = radius.lg,
  bordered = true,
  style,
  children,
  ...rest
}: GlassProps) {
  const tint = TINT[tone];

  return (
    <View
      {...rest}
      style={[
        styles.container,
        {
          borderRadius: radiusSize,
          borderWidth: bordered ? StyleSheet.hairlineWidth * 2 : 0,
          borderColor: tint.border,
        },
        style,
      ]}
    >
      <BlurView
        intensity={intensity}
        tint={tone === 'dark' ? 'dark' : 'light'}
        experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
        style={StyleSheet.absoluteFill}
      />
      {/* Tint sits above the blur so the material keeps a consistent value
          regardless of what is behind it. */}
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: tint.overlay }]}
        pointerEvents="none"
      />
      {/* Specular top edge — the single cue that sells this as a solid pane
          of glass rather than a translucent rectangle. */}
      <View
        style={[styles.highlight, { backgroundColor: tint.highlight }]}
        pointerEvents="none"
      />
      {children}
    </View>
  );
}

/** Backdrop colour used behind glass so it never floats over bare white. */
export const GLASS_BACKDROP = palette.white;

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
  highlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth * 2,
  },
});
