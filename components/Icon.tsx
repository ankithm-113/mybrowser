import React from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';

import { colors } from './theme';

/**
 * Geometric monochrome icons drawn with plain Views.
 *
 * Deliberately dependency-free: adding an icon font or react-native-svg would
 * mean another native rebuild, and every glyph here is simple enough to express
 * with borders and radii.
 */

export type IconName =
  | 'globe'
  | 'vault'
  | 'target'
  | 'sliders'
  | 'mic'
  | 'stop'
  | 'refresh'
  | 'chevronLeft'
  | 'chevronRight'
  | 'plus'
  | 'close'
  | 'check'
  | 'arrowRight'
  | 'document'
  | 'eye'
  | 'eyeOff';

interface Props {
  name: IconName;
  size?: number;
  color?: string;
  /** Stroke weight; defaults to a size-proportional hairline. */
  weight?: number;
  /**
   * Surface the icon sits on. Used by glyphs that punch a gap out of a shape
   * (refresh, eyeOff) so the cut matches the background behind them.
   */
  bg?: string;
}

export default function Icon({
  name,
  size = 22,
  color = colors.text,
  weight,
  bg = colors.bg,
}: Props) {
  const w = weight ?? Math.max(1.5, size * 0.085);
  const box: ViewStyle = { width: size, height: size };

  switch (name) {
    case 'globe':
      return (
        <View style={[box, styles.center]}>
          <View
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: w,
              borderColor: color,
            }}
          />
          <View
            style={[
              styles.abs,
              {
                width: size * 0.46,
                height: size,
                borderRadius: size / 2,
                borderWidth: w * 0.85,
                borderColor: color,
              },
            ]}
          />
          <View
            style={[styles.abs, { width: size, height: w * 0.85, backgroundColor: color }]}
          />
        </View>
      );

    case 'vault':
      return (
        <View style={[box, styles.center]}>
          <View
            style={{
              width: size,
              height: size * 0.86,
              borderRadius: size * 0.2,
              borderWidth: w,
              borderColor: color,
            }}
          />
          <View
            style={[
              styles.abs,
              {
                width: size * 0.3,
                height: size * 0.3,
                borderRadius: size * 0.15,
                borderWidth: w * 0.85,
                borderColor: color,
              },
            ]}
          />
          <View
            style={[
              styles.abs,
              {
                width: w * 0.85,
                height: size * 0.2,
                backgroundColor: color,
                transform: [{ translateX: size * 0.24 }],
              },
            ]}
          />
        </View>
      );

    case 'target':
      return (
        <View style={[box, styles.center]}>
          <View
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
              borderWidth: w,
              borderColor: color,
            }}
          />
          <View
            style={[
              styles.abs,
              {
                width: size * 0.54,
                height: size * 0.54,
                borderRadius: size * 0.27,
                borderWidth: w * 0.85,
                borderColor: color,
              },
            ]}
          />
          <View
            style={[
              styles.abs,
              {
                width: size * 0.16,
                height: size * 0.16,
                borderRadius: size * 0.08,
                backgroundColor: color,
              },
            ]}
          />
        </View>
      );

    case 'sliders': {
      const rows = [0.22, 0.5, 0.78];
      const knobAt = [0.68, 0.3, 0.56];
      return (
        <View style={box}>
          {rows.map((y, i) => (
            <View key={y}>
              <View
                style={{
                  position: 'absolute',
                  top: size * y - w / 2,
                  width: size,
                  height: w,
                  borderRadius: w,
                  backgroundColor: color,
                }}
              />
              <View
                style={{
                  position: 'absolute',
                  top: size * y - size * 0.11,
                  left: size * knobAt[i] - size * 0.11,
                  width: size * 0.22,
                  height: size * 0.22,
                  borderRadius: size * 0.11,
                  borderWidth: w,
                  borderColor: color,
                  backgroundColor: bg,
                }}
              />
            </View>
          ))}
        </View>
      );
    }

    case 'mic':
      return (
        <View style={[box, styles.center]}>
          {/* Capsule head */}
          <View
            style={{
              position: 'absolute',
              top: size * 0.04,
              width: size * 0.36,
              height: size * 0.5,
              borderRadius: size * 0.18,
              backgroundColor: color,
            }}
          />
          {/* U-shaped cradle: a bordered box with the top edge removed */}
          <View
            style={{
              position: 'absolute',
              top: size * 0.4,
              width: size * 0.68,
              height: size * 0.3,
              borderWidth: w,
              borderTopWidth: 0,
              borderColor: color,
              borderBottomLeftRadius: size * 0.34,
              borderBottomRightRadius: size * 0.34,
              backgroundColor: 'transparent',
            }}
          />
          {/* Stem */}
          <View
            style={{
              position: 'absolute',
              top: size * 0.7,
              width: w,
              height: size * 0.16,
              backgroundColor: color,
            }}
          />
          {/* Base */}
          <View
            style={{
              position: 'absolute',
              top: size * 0.86,
              width: size * 0.36,
              height: w,
              borderRadius: w,
              backgroundColor: color,
            }}
          />
        </View>
      );

    case 'stop':
      return (
        <View style={[box, styles.center]}>
          <View
            style={{
              width: size * 0.62,
              height: size * 0.62,
              borderRadius: size * 0.14,
              backgroundColor: color,
            }}
          />
        </View>
      );

    case 'refresh': {
      /**
       * A complete ring, with the gap punched out by a background-coloured
       * patch and an arrowhead at the 12 o'clock end. Cutting the gap this way
       * avoids the mitre seam that `borderTopColor: 'transparent'` leaves on a
       * rounded border, which is what made earlier versions read as a magnifier.
       */
      const ring = size * 0.76;
      const head = size * 0.15;
      return (
        <View style={[box, styles.center]}>
          <View
            style={{
              width: ring,
              height: ring,
              borderRadius: ring / 2,
              borderWidth: w,
              borderColor: color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              top: -size * 0.02,
              left: size * 0.56,
              width: size * 0.4,
              height: size * 0.4,
              backgroundColor: bg,
            }}
          />
          <View
            style={{
              position: 'absolute',
              width: 0,
              height: 0,
              borderTopWidth: head,
              borderBottomWidth: head,
              borderLeftWidth: head * 1.35,
              borderTopColor: 'transparent',
              borderBottomColor: 'transparent',
              borderLeftColor: color,
              transform: [{ translateY: -ring / 2 }, { translateX: size * 0.04 }],
            }}
          />
        </View>
      );
    }

    case 'chevronLeft':
    case 'chevronRight':
      return (
        <View style={[box, styles.center]}>
          <View
            style={{
              width: size * 0.4,
              height: size * 0.4,
              borderLeftWidth: w,
              borderBottomWidth: w,
              borderColor: color,
              transform: [
                { rotate: name === 'chevronLeft' ? '45deg' : '-135deg' },
                { translateX: name === 'chevronLeft' ? size * 0.06 : 0 },
              ],
            }}
          />
        </View>
      );

    case 'arrowRight':
      return (
        <View style={[box, styles.center]}>
          <View
            style={{ width: size * 0.8, height: w, borderRadius: w, backgroundColor: color }}
          />
          <View
            style={{
              position: 'absolute',
              right: size * 0.06,
              width: size * 0.32,
              height: size * 0.32,
              borderTopWidth: w,
              borderRightWidth: w,
              borderColor: color,
              transform: [{ rotate: '45deg' }],
            }}
          />
        </View>
      );

    case 'plus':
      return (
        <View style={[box, styles.center]}>
          <View
            style={{ position: 'absolute', width: size, height: w, borderRadius: w, backgroundColor: color }}
          />
          <View
            style={{ position: 'absolute', width: w, height: size, borderRadius: w, backgroundColor: color }}
          />
        </View>
      );

    case 'close':
      return (
        <View style={[box, styles.center]}>
          <View
            style={{
              position: 'absolute',
              width: size * 0.92,
              height: w,
              borderRadius: w,
              backgroundColor: color,
              transform: [{ rotate: '45deg' }],
            }}
          />
          <View
            style={{
              position: 'absolute',
              width: size * 0.92,
              height: w,
              borderRadius: w,
              backgroundColor: color,
              transform: [{ rotate: '-45deg' }],
            }}
          />
        </View>
      );

    case 'check':
      return (
        <View style={[box, styles.center]}>
          <View
            style={{
              width: size * 0.52,
              height: size * 0.28,
              borderLeftWidth: w,
              borderBottomWidth: w,
              borderColor: color,
              transform: [{ rotate: '-45deg' }, { translateY: -size * 0.06 }],
            }}
          />
        </View>
      );

    case 'eye':
    case 'eyeOff':
      return (
        <View style={[box, styles.center]}>
          {/* Lens: a stadium shape reads as an eye outline at icon sizes. */}
          <View
            style={{
              width: size,
              height: size * 0.62,
              borderRadius: size * 0.31,
              borderWidth: w,
              borderColor: color,
            }}
          />
          <View
            style={[
              styles.abs,
              {
                width: size * 0.26,
                height: size * 0.26,
                borderRadius: size * 0.13,
                backgroundColor: color,
              },
            ]}
          />
          {name === 'eyeOff' && (
            <>
              {/* Slash, backed by a bg-coloured stroke so it reads as cut-through. */}
              <View
                style={[
                  styles.abs,
                  {
                    width: size * 1.15,
                    height: w * 2.4,
                    backgroundColor: bg,
                    transform: [{ rotate: '-45deg' }],
                  },
                ]}
              />
              <View
                style={[
                  styles.abs,
                  {
                    width: size * 1.15,
                    height: w,
                    borderRadius: w,
                    backgroundColor: color,
                    transform: [{ rotate: '-45deg' }],
                  },
                ]}
              />
            </>
          )}
        </View>
      );

    case 'document':
      return (
        <View style={[box, styles.center]}>
          <View
            style={{
              width: size * 0.74,
              height: size * 0.92,
              borderRadius: size * 0.1,
              borderWidth: w,
              borderColor: color,
            }}
          />
          {[0.34, 0.5, 0.66].map((y) => (
            <View
              key={y}
              style={{
                position: 'absolute',
                top: size * y,
                width: size * 0.38,
                height: w * 0.8,
                backgroundColor: color,
              }}
            />
          ))}
        </View>
      );

    default:
      return <View style={box} />;
  }
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  abs: { position: 'absolute' },
});
