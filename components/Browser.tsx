import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  KeyboardAvoidingView,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from 'react-native';
import { WebView, WebViewNavigation } from 'react-native-webview';

import { DOM_READER_JS } from '@/assets/dom_reader';
import { AgentDecision, AgentRunResult, AgentStatus } from '@/types';
import { runAgent } from '@/services/agentLoop';
import { confirm } from '@/services/dialog';
import { executor } from '@/services/executor';
import AgentOverlay from './AgentOverlay';
import { IconButton } from './ui';
import { colors, radius, space, type } from './theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const HOME_URL = 'https://duckduckgo.com/';

interface Tab {
  id: string;
  url: string;
  title: string;
}

export interface BrowserHandle {
  navigate(url: string): void;
  /** Navigates to `url` (if given) then runs the agentic loop against the task. */
  runTask(task: string, url?: string): Promise<AgentRunResult>;
  stop(): void;
  isRunning(): boolean;
}

interface Props {
  onRunFinished?: (result: AgentRunResult) => void;
}

function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return HOME_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const looksLikeDomain = /^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(trimmed);
  return looksLikeDomain
    ? `https://${trimmed}`
    : `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

const IDLE_STATUS: AgentStatus = { phase: 'idle', message: '', step: 0, maxSteps: 0 };

const Browser = forwardRef<BrowserHandle, Props>(({ onRunFinished }, ref) => {
  const webRef = useRef<WebView>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const [tabs, setTabs] = useState<Tab[]>([
    { id: 't1', url: HOME_URL, title: 'New tab' },
  ]);
  const [activeTabId, setActiveTabId] = useState('t1');
  const [addressText, setAddressText] = useState(HOME_URL);
  const [currentUrl, setCurrentUrl] = useState(HOME_URL);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [showTabs, setShowTabs] = useState(false);
  const [status, setStatus] = useState<AgentStatus>(IDLE_STATUS);
  const [lastThought, setLastThought] = useState<string>();
  const [pausedReason, setPausedReason] = useState<string | null>(null);
  const resumeRef = useRef<((proceed: boolean) => void) | null>(null);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId]
  );

  /* ----------------------------- webview plumbing ---------------------------- */

  const attach = useCallback(() => {
    executor.attach({
      injectJavaScript: (script: string) => webRef.current?.injectJavaScript(script),
    });
    // SPA route changes fire no load event; the page reports them instead so
    // the address bar and the agent both see the new URL.
    executor.onUrlChange = (url: string) => {
      setCurrentUrl(url);
      setAddressText(url);
    };
  }, []);

  const handleMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    executor.handleMessage(event.nativeEvent.data);
  }, []);

  const handleNavigationStateChange = useCallback(
    (nav: WebViewNavigation) => {
      setCurrentUrl(nav.url);
      setCanGoBack(nav.canGoBack);
      setCanGoForward(nav.canGoForward);
      if (!nav.loading) setAddressText(nav.url);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId ? { ...t, url: nav.url, title: nav.title || t.title } : t
        )
      );
      // Only a real document load invalidates in-flight bridge requests. SPA
      // route changes fire this too, and resetting on those would cancel the
      // waits the agent depends on mid-run.
      if (nav.loading) executor.reset('page navigated');
    },
    [activeTabId]
  );

  const go = useCallback(
    (raw: string) => {
      const url = normaliseUrl(raw);
      setAddressText(url);
      setCurrentUrl(url);
      setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, url } : t)));
    },
    [activeTabId]
  );

  /* --------------------------------- tabs ---------------------------------- */

  const newTab = useCallback(() => {
    const id = `t${Date.now().toString(36)}`;
    setTabs((prev) => [...prev, { id, url: HOME_URL, title: 'New tab' }]);
    setActiveTabId(id);
    setAddressText(HOME_URL);
    setShowTabs(false);
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        if (prev.length === 1) return prev;
        const next = prev.filter((t) => t.id !== id);
        if (id === activeTabId) {
          const fallback = next[next.length - 1];
          setActiveTabId(fallback.id);
          setAddressText(fallback.url);
        }
        return next;
      });
    },
    [activeTabId]
  );

  /* -------------------------------- the agent ------------------------------- */

  const confirmSubmit = useCallback(
    (decision: AgentDecision) =>
      confirm({
        title: 'Confirm submission',
        message: `The agent wants to submit this page.\n\n"${decision.thought}"`,
        confirmLabel: 'Submit',
      }),
    []
  );

  /**
   * Human-in-the-loop gate. The loop parks here when it hits a login wall or
   * challenge; the overlay's Resume button settles the promise.
   */
  const awaitResume = useCallback(
    (reason: string) =>
      new Promise<boolean>((resolve) => {
        setPausedReason(reason);
        resumeRef.current = (proceed: boolean) => {
          resumeRef.current = null;
          setPausedReason(null);
          resolve(proceed);
        };
      }),
    []
  );

  const resume = useCallback(() => resumeRef.current?.(true), []);

  const stop = useCallback(() => {
    // A parked run is waiting on a promise, not on the abort signal.
    resumeRef.current?.(false);
    abortRef.current?.abort();
    executor.reset('stopped by user');
    runningRef.current = false;
    setStatus(IDLE_STATUS);
  }, []);

  const runTask = useCallback(
    async (task: string, url?: string): Promise<AgentRunResult> => {
      if (runningRef.current) {
        return { ok: false, summary: 'An agent run is already in progress.', steps: 0, log: [] };
      }
      runningRef.current = true;
      attach();

      if (url) {
        go(url);
        // Give the WebView time to load and inject dom_reader before step 1.
        await new Promise((r) => setTimeout(r, 2500));
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setLastThought(undefined);
      setStatus({ phase: 'thinking', message: 'Starting agent...', step: 0, maxSteps: 0, task });

      let result: AgentRunResult;
      try {
        result = await runAgent({
          task,
          executor,
          signal: controller.signal,
          onStatus: setStatus,
          onLog: (entry) => setLastThought(entry.thought),
          confirmSubmit,
          awaitResume,
        });
      } catch (err) {
        result = {
          ok: false,
          summary: err instanceof Error ? err.message : String(err),
          steps: 0,
          log: [],
        };
      }

      runningRef.current = false;
      abortRef.current = null;
      resumeRef.current = null;
      setPausedReason(null);
      setStatus({
        phase: result.ok ? 'done' : 'error',
        message: result.summary,
        step: result.steps,
        maxSteps: result.steps,
        task,
      });
      onRunFinished?.(result);
      return result;
    },
    [attach, go, confirmSubmit, awaitResume, onRunFinished]
  );

  useImperativeHandle(ref, () => ({
    navigate: go,
    runTask,
    stop,
    isRunning: () => runningRef.current,
  }));

  /* --------------------------------- render -------------------------------- */

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.chrome}>
        <IconButton
          name="chevronLeft"
          label="Back"
          disabled={!canGoBack}
          onPress={() => webRef.current?.goBack()}
        />
        <IconButton
          name="chevronRight"
          label="Forward"
          disabled={!canGoForward}
          onPress={() => webRef.current?.goForward()}
        />

        <TextInput
          style={styles.address}
          value={addressText}
          onChangeText={setAddressText}
          onSubmitEditing={() => go(addressText)}
          placeholder="Search or enter a URL"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          selectTextOnFocus
          keyboardType="url"
          returnKeyType="go"
        />

        <IconButton name="refresh" label="Reload" onPress={() => webRef.current?.reload()} />

        <Pressable
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setShowTabs((v) => !v);
          }}
          style={({ pressed }) => [
            styles.tabsBtn,
            showTabs && styles.tabsBtnActive,
            pressed && styles.tabsBtnPressed,
          ]}
        >
          <Text style={[styles.tabsBtnText, showTabs && styles.tabsBtnTextActive]}>
            {tabs.length}
          </Text>
        </Pressable>
      </View>

      {showTabs && (
        <View style={styles.tabStrip}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tabStripContent}
          >
            {tabs.map((tab) => (
              <Pressable
                key={tab.id}
                style={({ pressed }) => [
                  styles.tabChip,
                  tab.id === activeTabId && styles.tabChipActive,
                  pressed && styles.tabChipPressed,
                ]}
                onPress={() => {
                  setActiveTabId(tab.id);
                  setAddressText(tab.url);
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setShowTabs(false);
                }}
                onLongPress={() => {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  closeTab(tab.id);
                }}
              >
                <Text
                  style={[
                    styles.tabChipText,
                    tab.id === activeTabId && styles.tabChipTextActive,
                  ]}
                  numberOfLines={1}
                >
                  {tab.title || tab.url}
                </Text>
              </Pressable>
            ))}
            <Pressable
              style={({ pressed }) => [styles.tabChip, pressed && styles.tabChipPressed]}
              onPress={newTab}
            >
              <Text style={styles.tabChipText}>New tab</Text>
            </Pressable>
          </ScrollView>
          <Text style={styles.tabHint}>Long-press a tab to close it</Text>
        </View>
      )}

      <View style={styles.webWrap}>
        <WebView
          key={activeTab.id}
          ref={webRef}
          source={{ uri: activeTab.url }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          thirdPartyCookiesEnabled
          sharedCookiesEnabled
          allowFileAccess
          setSupportMultipleWindows={false}
          injectedJavaScript={DOM_READER_JS}
          onMessage={handleMessage}
          onLoadStart={attach}
          onLoadEnd={() => {
            attach();
            // Re-inject after client-side hydration replaces the DOM.
            setTimeout(() => webRef.current?.injectJavaScript(DOM_READER_JS), 700);
          }}
          onNavigationStateChange={handleNavigationStateChange}
          onError={({ nativeEvent }) =>
            setStatus({
              phase: 'error',
              message: `Page failed to load: ${nativeEvent.description}`,
              step: 0,
              maxSteps: 0,
            })
          }
          userAgent={
            'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/120.0.0.0 Mobile Safari/537.36'
          }
          style={styles.web}
        />

        <AgentOverlay
          status={status}
          onStop={stop}
          lastThought={lastThought}
          onResume={pausedReason ? resume : undefined}
        />
      </View>

      <Text style={styles.urlBar} numberOfLines={1}>
        {currentUrl}
      </Text>
    </KeyboardAvoidingView>
  );
});

Browser.displayName = 'Browser';
export default Browser;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  chrome: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    gap: space.xs,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  address: {
    flex: 1,
    backgroundColor: colors.sunken,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: 13,
    marginHorizontal: space.xs,
  },
  tabsBtn: {
    minWidth: 34,
    height: 34,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabsBtnActive: { backgroundColor: colors.fill, borderColor: colors.fill },
  tabsBtnPressed: { backgroundColor: colors.sunken },
  tabsBtnText: { ...type.small, fontWeight: '700', color: colors.text },
  tabsBtnTextActive: { color: colors.onFill },

  tabStrip: {
    backgroundColor: colors.surface,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tabStripContent: { paddingHorizontal: space.md, gap: space.sm },
  tabChip: {
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    maxWidth: 190,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabChipActive: { backgroundColor: colors.fill, borderColor: colors.fill },
  tabChipPressed: { backgroundColor: colors.sunken },
  tabChipText: { ...type.small, fontWeight: '600', color: colors.textDim },
  tabChipTextActive: { color: colors.onFill },
  tabHint: {
    ...type.micro,
    color: colors.textFaint,
    marginTop: space.sm,
    paddingHorizontal: space.lg,
  },

  webWrap: { flex: 1, backgroundColor: colors.bg },
  web: { flex: 1, backgroundColor: colors.bg },

  urlBar: {
    ...type.micro,
    fontWeight: '400',
    color: colors.textFaint,
    paddingHorizontal: space.lg,
    paddingVertical: 6,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
