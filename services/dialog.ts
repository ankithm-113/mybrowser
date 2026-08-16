/**
 * App-styled dialogs.
 *
 * Replaces React Native's `Alert`, which renders the OS's own widget and so
 * cannot follow the app's monochrome design system. Call sites use a
 * promise-based API instead of callbacks.
 *
 * A DialogHost mounted at the app root registers the handler. If nothing is
 * mounted — a background task, or a crash before the tree renders — the call
 * falls back to the native Alert so a message is never silently swallowed.
 */

import { Alert } from 'react-native';

export interface DialogAction {
  label: string;
  /** `primary` is the filled button; `secondary` is outlined. */
  variant?: 'primary' | 'secondary';
  /** Marks the action as the cancel/dismiss path (used for the back button). */
  cancel?: boolean;
}

export interface DialogRequest {
  title: string;
  message?: string;
  actions: DialogAction[];
}

/** Resolves with the index of the action the user chose. */
type DialogHandler = (request: DialogRequest) => Promise<number>;

let handler: DialogHandler | null = null;

export function registerDialogHandler(next: DialogHandler | null): void {
  handler = next;
}

export function showDialog(request: DialogRequest): Promise<number> {
  if (handler) return handler(request);

  // No host mounted — degrade to the platform dialog rather than lose the message.
  return new Promise((resolve) => {
    Alert.alert(
      request.title,
      request.message,
      request.actions.map((action, index) => ({
        text: action.label,
        style: action.cancel ? ('cancel' as const) : ('default' as const),
        onPress: () => resolve(index),
      })),
      { cancelable: false }
    );
  });
}

/** Single-button acknowledgement. */
export async function alert(title: string, message?: string): Promise<void> {
  await showDialog({ title, message, actions: [{ label: 'OK', variant: 'primary' }] });
}

/** Two-button question. Resolves true when the confirm action is chosen. */
export async function confirm(options: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}): Promise<boolean> {
  const chosen = await showDialog({
    title: options.title,
    message: options.message,
    actions: [
      { label: options.cancelLabel ?? 'Cancel', variant: 'secondary', cancel: true },
      { label: options.confirmLabel ?? 'Confirm', variant: 'primary' },
    ],
  });
  return chosen === 1;
}
