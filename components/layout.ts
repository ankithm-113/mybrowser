import { Platform } from 'react-native';

/**
 * The tab bar floats over content so the glass has something to blur, which
 * means every scrollable screen has to reserve this much room at the bottom.
 * Shared from one place so the bar and the padding can never drift apart.
 */
export const TAB_BAR_HEIGHT = Platform.OS === 'ios' ? 84 : 70;

/** Bottom padding for scroll containers sitting under the floating tab bar. */
export const TAB_BAR_INSET = TAB_BAR_HEIGHT + 16;
