import { Platform, StyleSheet } from 'react-native';

/**
 * Design system — light, strictly monochrome.
 *
 * No hue anywhere: every value is pure black, pure white, or a neutral gray
 * between them. Emphasis is carried by weight, fill and contrast instead of
 * colour, which is what keeps a one-colour interface readable.
 */

export const palette = {
  white: '#FFFFFF',
  gray50: '#FAFAFA',
  gray100: '#F4F4F4',
  gray150: '#ECECEC',
  gray200: '#E2E2E2',
  gray300: '#D0D0D0',
  gray400: '#A8A8A8',
  gray500: '#7A7A7A',
  gray600: '#575757',
  gray700: '#3A3A3A',
  gray800: '#212121',
  ink: '#0A0A0A',
  black: '#000000',
} as const;

export const colors = {
  /** Page background. */
  bg: palette.white,
  /** Raised card on the page. */
  surface: palette.white,
  /** Recessed field / chip background. */
  sunken: palette.gray100,
  /** Slightly softer recess for nested blocks. */
  sunkenAlt: palette.gray50,

  border: palette.gray200,
  borderStrong: palette.gray300,

  text: palette.ink,
  textDim: palette.gray500,
  textFaint: palette.gray400,
  /** Text on top of a filled black surface. */
  onFill: palette.white,

  /** Primary fill for buttons, active states, meters. */
  fill: palette.ink,
  fillPressed: palette.gray700,
  fillDisabled: palette.gray300,

  /** Emphasis tiers, used where colour would normally signal status. */
  strong: palette.ink,
  medium: palette.gray500,
  weak: palette.gray400,

  scrim: 'rgba(10,10,10,0.04)',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

/** Subtle neutral elevation — never a coloured shadow. */
export const elevation = {
  card: Platform.select({
    ios: {
      shadowColor: palette.black,
      shadowOpacity: 0.05,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 2 },
    },
    android: { elevation: 1 },
    default: {},
  }),
  raised: Platform.select({
    ios: {
      shadowColor: palette.black,
      shadowOpacity: 0.1,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 6 },
    },
    android: { elevation: 6 },
    default: {},
  }),
} as const;

export const type = {
  display: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.6 },
  h1: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.4 },
  h2: { fontSize: 16, fontWeight: '700' as const, letterSpacing: -0.2 },
  body: { fontSize: 14, fontWeight: '400' as const },
  bodyStrong: { fontSize: 14, fontWeight: '600' as const },
  small: { fontSize: 12, fontWeight: '400' as const },
  label: { fontSize: 11, fontWeight: '700' as const, letterSpacing: 0.6 },
  micro: { fontSize: 10, fontWeight: '600' as const, letterSpacing: 0.4 },
} as const;

/** Monochrome switch colours, shared by every toggle in the app. */
export const switchColors = {
  trackColor: { true: colors.fill, false: colors.borderStrong },
  thumbColor: palette.white,
  ios_backgroundColor: colors.borderStrong,
} as const;

export const shared = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },

  pad: { padding: space.lg },
  row: { flexDirection: 'row', alignItems: 'center' },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    marginBottom: space.md,
    ...elevation.card,
  },

  display: { ...type.display, color: colors.text },
  h1: { ...type.h1, color: colors.text },
  h2: { ...type.h2, color: colors.text },
  body: { ...type.body, color: colors.text, lineHeight: 20 },
  bodyStrong: { ...type.bodyStrong, color: colors.text, lineHeight: 20 },
  dim: { ...type.small, color: colors.textDim, lineHeight: 18 },

  /** Uppercase field label. */
  label: {
    ...type.label,
    color: colors.textDim,
    textTransform: 'uppercase',
    marginBottom: space.sm,
  },

  divider: { height: 1, backgroundColor: colors.border },
});
