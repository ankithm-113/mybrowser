/**
 * The tab bar floats as a detached glass slab with a gap on every side, so
 * content scrolls visibly beneath it — that motion is what makes the blur
 * legible as glass. Every scrollable screen must reserve TAB_BAR_INSET at the
 * bottom, and it all derives from here so the numbers cannot drift apart.
 */

/** Height of the floating bar itself, excluding safe-area. */
export const FLOATING_BAR_HEIGHT = 68;

/** Gap between the bar and the left/right screen edges. */
export const FLOATING_BAR_MARGIN = 14;

/** Gap below the bar, on top of the safe-area inset. Small, so it sits low. */
export const FLOATING_BAR_BOTTOM = 4;

export const FLOATING_BAR_RADIUS = 26;

/** Bottom padding for scroll containers sitting under the floating bar. */
export const TAB_BAR_INSET = FLOATING_BAR_HEIGHT + FLOATING_BAR_MARGIN + 40;

/** Space the Browser screen reserves so the bar never covers a live page. */
export const TAB_BAR_HEIGHT = FLOATING_BAR_HEIGHT + FLOATING_BAR_MARGIN;
