import React, { useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';

import Icon, { IconName } from './Icon';
import { colors, radius, space, type } from './theme';

/* --------------------------------- Button --------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  /** Compact height, for inline actions. */
  small?: boolean;
}

/**
 * Presses scale down slightly with a spring — the whole app's tap feedback is
 * this one animation, so interactions feel consistent.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
  style,
  small,
}: ButtonProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const spring = (to: number) =>
    Animated.spring(scale, {
      toValue: to,
      useNativeDriver: true,
      speed: 40,
      bounciness: 0,
    }).start();

  const isPrimary = variant === 'primary';
  const inactive = disabled || loading;
  const fg = isPrimary ? colors.onFill : colors.text;

  return (
    <Animated.View style={[{ transform: [{ scale }] }, style]}>
      <Pressable
        onPress={onPress}
        disabled={inactive}
        onPressIn={() => spring(0.97)}
        onPressOut={() => spring(1)}
        style={({ pressed }) => [
          styles.button,
          small && styles.buttonSmall,
          isPrimary && styles.buttonPrimary,
          variant === 'secondary' && styles.buttonSecondary,
          variant === 'ghost' && styles.buttonGhost,
          pressed && isPrimary && styles.buttonPrimaryPressed,
          pressed && !isPrimary && styles.buttonSecondaryPressed,
          inactive && (isPrimary ? styles.buttonPrimaryDisabled : styles.buttonDisabled),
        ]}
      >
        {loading ? (
          <ActivityIndicator size="small" color={fg} />
        ) : (
          <View style={styles.buttonInner}>
            {icon && <Icon name={icon} size={small ? 14 : 16} color={inactive ? colors.textFaint : fg} />}
            <Text
              style={[
                styles.buttonLabel,
                small && styles.buttonLabelSmall,
                { color: inactive ? colors.textFaint : fg },
              ]}
              numberOfLines={1}
            >
              {label}
            </Text>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

/* -------------------------------- IconButton ------------------------------- */

interface IconButtonProps {
  name: IconName;
  onPress?: () => void;
  disabled?: boolean;
  active?: boolean;
  size?: number;
  label?: string;
}

export function IconButton({ name, onPress, disabled, active, size = 20, label }: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={6}
      style={({ pressed }) => [
        styles.iconButton,
        active && styles.iconButtonActive,
        pressed && styles.iconButtonPressed,
      ]}
    >
      <Icon
        name={name}
        size={size}
        color={disabled ? colors.textFaint : active ? colors.onFill : colors.text}
      />
    </Pressable>
  );
}

/* ---------------------------------- Chip ---------------------------------- */

interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
}

export function Chip({ label, selected, onPress }: ChipProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && styles.chipPressed,
      ]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

/* --------------------------------- Field ---------------------------------- */

interface FieldProps extends TextInputProps {
  label?: string;
  hint?: string;
}

export function Field({ label, hint, style, ...rest }: FieldProps) {
  return (
    <View style={styles.fieldWrap}>
      {!!label && <Text style={styles.fieldLabel}>{label}</Text>}
      <TextInput
        placeholderTextColor={colors.textFaint}
        {...rest}
        style={[styles.input, rest.multiline && styles.inputMultiline, style]}
      />
      {!!hint && <Text style={styles.fieldHint}>{hint}</Text>}
    </View>
  );
}

/* ------------------------------- SecretField ------------------------------ */

interface SecretFieldProps {
  label: string;
  role: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  /** Where to get the key, shown under the input. */
  source?: string;
}

/**
 * Masked-but-pasteable credential card. Each key gets its own box.
 *
 * Deliberately never uses `secureTextEntry`: Android suppresses the paste
 * context menu on password inputs, and toggling that prop at runtime wipes the
 * field on some ROMs. The value is instead hidden behind a masked preview, and
 * editing happens in an ordinary text input where paste, select-all and the
 * clipboard bar all behave normally.
 */
export function SecretField({
  label,
  role,
  value,
  onChangeText,
  placeholder,
  source,
}: SecretFieldProps) {
  const [revealed, setRevealed] = React.useState(false);
  const hasValue = !!value.trim();
  const showInput = revealed || !hasValue;

  const masked =
    value.length > 10 ? `${'•'.repeat(14)}${value.slice(-4)}` : '•'.repeat(Math.max(value.length, 6));

  return (
    <View style={styles.secretCard}>
      <View style={styles.secretHeader}>
        <View style={styles.flex}>
          <Text style={styles.secretLabel}>{label}</Text>
          <Text style={styles.secretRole}>{role}</Text>
        </View>
        <Badge label={hasValue ? 'Set' : 'Not set'} filled={hasValue} />
      </View>

      <View style={styles.secretRow}>
        {showInput ? (
          <TextInput
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            textContentType="none"
            importantForAutofill="no"
            multiline={false}
            style={[styles.input, styles.secretInput]}
          />
        ) : (
          <Pressable
            onPress={() => setRevealed(true)}
            style={({ pressed }) => [
              styles.input,
              styles.secretInput,
              styles.secretMask,
              pressed && styles.secretMaskPressed,
            ]}
          >
            <Text style={styles.secretMaskText} numberOfLines={1}>
              {masked}
            </Text>
          </Pressable>
        )}

        {hasValue && (
          <Pressable
            onPress={() => setRevealed((v) => !v)}
            hitSlop={8}
            accessibilityLabel={revealed ? 'Hide key' : 'Show key'}
            style={({ pressed }) => [styles.eyeButton, pressed && styles.eyeButtonPressed]}
          >
            <Icon name={revealed ? 'eyeOff' : 'eye'} size={18} color={colors.text} />
          </Pressable>
        )}
      </View>

      <Text style={styles.fieldHint}>
        {hasValue && !revealed
          ? 'Tap the field or the eye to reveal and edit.'
          : source
          ? `Long-press to paste  ·  ${source}`
          : 'Long-press to paste.'}
      </Text>
    </View>
  );
}

/* -------------------------------- Structure ------------------------------- */

export function SectionHeader({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {!!action && (
        <Pressable onPress={onAction} hitSlop={8} style={({ pressed }) => pressed && styles.faded}>
          <Text style={styles.link}>{action}</Text>
        </Pressable>
      )}
    </View>
  );
}

export function Meter({ percent }: { percent: number }) {
  return (
    <View style={styles.meterTrack}>
      <View style={[styles.meterFill, { width: `${Math.max(0, Math.min(100, percent))}%` }]} />
    </View>
  );
}

/**
 * Status pill. With no colour available, emphasis is the signal: `filled`
 * reads as active, outlined as neutral.
 */
export function Badge({ label, filled }: { label: string; filled?: boolean }) {
  return (
    <View style={[styles.badge, filled && styles.badgeFilled]}>
      <Text style={[styles.badgeLabel, filled && styles.badgeLabelFilled]}>{label}</Text>
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  buttonSmall: { height: 38, paddingHorizontal: space.md, borderRadius: radius.sm },
  buttonInner: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  buttonPrimary: { backgroundColor: colors.fill },
  buttonPrimaryPressed: { backgroundColor: colors.fillPressed },
  buttonPrimaryDisabled: { backgroundColor: colors.sunken },
  buttonSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  buttonSecondaryPressed: { backgroundColor: colors.sunken },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonDisabled: { borderColor: colors.border },
  buttonLabel: { ...type.bodyStrong },
  buttonLabelSmall: { fontSize: 13 },

  iconButton: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonActive: { backgroundColor: colors.fill },
  iconButtonPressed: { backgroundColor: colors.sunken },

  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.fill, borderColor: colors.fill },
  chipPressed: { backgroundColor: colors.sunken },
  chipLabel: { ...type.small, fontWeight: '600', color: colors.textDim },
  chipLabelSelected: { color: colors.onFill },

  flex: { flex: 1 },
  fieldWrap: { marginBottom: space.md },
  fieldLabel: {
    ...type.label,
    color: colors.textDim,
    textTransform: 'uppercase',
    marginBottom: space.sm,
  },
  fieldHint: { ...type.small, color: colors.textFaint, marginTop: space.xs },
  secretCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    marginBottom: space.md,
  },
  secretHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginBottom: space.md,
  },
  secretLabel: { ...type.bodyStrong, color: colors.text },
  secretRole: { ...type.small, color: colors.textDim, marginTop: 2 },
  secretRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  secretInput: {
    flex: 1,
    marginBottom: 0,
    fontSize: 13,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  secretMask: { justifyContent: 'center' },
  secretMaskPressed: { backgroundColor: colors.sunken },
  secretMaskText: {
    fontSize: 13,
    color: colors.textDim,
    letterSpacing: 1.5,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  eyeButton: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyeButtonPressed: { backgroundColor: colors.sunken },
  input: {
    backgroundColor: colors.sunkenAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: 14,
  },
  inputMultiline: { minHeight: 92, textAlignVertical: 'top' },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  sectionTitle: { ...type.h2, color: colors.text },
  link: { ...type.small, fontWeight: '700', color: colors.text },
  faded: { opacity: 0.5 },

  meterTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.sunken,
    overflow: 'hidden',
  },
  meterFill: { height: 6, borderRadius: 3, backgroundColor: colors.fill },

  badge: {
    paddingHorizontal: space.sm + 2,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignSelf: 'flex-start',
  },
  badgeFilled: { backgroundColor: colors.fill, borderColor: colors.fill },
  badgeLabel: { ...type.micro, color: colors.textDim, textTransform: 'uppercase' },
  badgeLabelFilled: { color: colors.onFill },

  divider: { height: 1, backgroundColor: colors.border },

  empty: { alignItems: 'center', paddingVertical: space.xxl, paddingHorizontal: space.lg },
  emptyTitle: { ...type.h2, color: colors.text, marginBottom: space.sm },
  emptyBody: { ...type.small, color: colors.textDim, textAlign: 'center', lineHeight: 18 },
});
