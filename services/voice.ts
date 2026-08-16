/**
 * Free on-device speech-to-text via expo-speech-recognition, which wraps the
 * platform recognisers (Android SpeechRecognizer / iOS SFSpeechRecognizer).
 * No cloud STT bill.
 *
 * The module is imported lazily so the app still runs in Expo Go, where the
 * native module is not present.
 */

type Listener = (transcript: string, isFinal: boolean) => void;

let module_: any = null;

function getModule(): any | null {
  if (module_) return module_;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    module_ = require('expo-speech-recognition');
    return module_;
  } catch {
    return null;
  }
}

export function isVoiceAvailable(): boolean {
  const m = getModule();
  return !!m?.ExpoSpeechRecognitionModule;
}

export async function requestVoicePermission(): Promise<boolean> {
  const m = getModule();
  if (!m) return false;
  const result = await m.ExpoSpeechRecognitionModule.requestPermissionsAsync();
  return !!result?.granted;
}

export interface VoiceSession {
  stop(): void;
}

/**
 * Starts a recognition session. `onResult` fires with interim transcripts and
 * once more with isFinal=true; `onEnd` always fires exactly once.
 */
export async function startListening(
  onResult: Listener,
  onEnd: (error?: string) => void
): Promise<VoiceSession | null> {
  const m = getModule();
  if (!m) {
    onEnd('Speech recognition is unavailable in this build (needs a dev client).');
    return null;
  }

  const { ExpoSpeechRecognitionModule } = m;

  if (!(await requestVoicePermission())) {
    onEnd('Microphone / speech permission was denied.');
    return null;
  }

  const subscriptions: Array<{ remove(): void }> = [];
  let finished = false;

  const finish = (error?: string) => {
    if (finished) return;
    finished = true;
    subscriptions.forEach((s) => s.remove());
    onEnd(error);
  };

  subscriptions.push(
    ExpoSpeechRecognitionModule.addListener('result', (event: any) => {
      const transcript = event?.results?.[0]?.transcript ?? '';
      if (transcript) onResult(transcript, !!event.isFinal);
    })
  );
  subscriptions.push(
    ExpoSpeechRecognitionModule.addListener('error', (event: any) =>
      finish(event?.message ?? event?.error ?? 'Speech recognition failed.')
    )
  );
  subscriptions.push(ExpoSpeechRecognitionModule.addListener('end', () => finish()));

  ExpoSpeechRecognitionModule.start({
    lang: 'en-US',
    interimResults: true,
    continuous: false,
    requiresOnDeviceRecognition: false,
  });

  return {
    stop() {
      try {
        ExpoSpeechRecognitionModule.stop();
      } catch {
        finish();
      }
    },
  };
}
