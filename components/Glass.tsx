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

const TINT: Record<GlassTone, { overlay: string; border: string }> = {
  // Frosted white — for bars and cards sitting over pale content.
  light: { overlay: 'rgba(255,255,255,0.72)', border: 'rgba(10,10,10,0.10)' },
  // Smoked glass — for selected states that need to read as "on".
  dark: { overlay: 'rgba(10,10,10,0.78)', border: 'rgba(255,255,255,0.18)' },
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
      {/* Tint sits above the blur so the material has a consistent value
          regardless of what is behind it. */}
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: tint.overlay }]}
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
});
