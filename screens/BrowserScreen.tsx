import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Browser, { BrowserHandle } from '@/components/Browser';
import { TAB_BAR_HEIGHT } from '@/components/layout';
import StatusSheet from '@/components/StatusSheet';
import { colors } from '@/components/theme';
import { AgentRequest, registerAgentHandler } from '@/services/agentBus';

/**
 * The browser, full-bleed.
 *
 * The command input used to live in a permanent bar at the top of this screen;
 * it now opens from the hero button in the tab bar (see AgentSheet), which
 * hands this screen the whole viewport for the page itself.
 */
export default function BrowserScreen() {
  const browserRef = useRef<BrowserHandle>(null);
  const [hint, setHint] = useState('');

  const runRequest = useCallback(async (request: AgentRequest) => {
    return (
      (await browserRef.current?.runTask(request.task, request.url)) ?? {
        ok: false,
        summary: 'Browser is not ready.',
        steps: 0,
        log: [],
      }
    );
  }, []);

  // Registers this screen as the executor for tasks dispatched from the sheet
  // or from the Jobs tab.
  useEffect(() => {
    registerAgentHandler(runRequest);
    return () => registerAgentHandler(null);
  }, [runRequest]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      {/* The agent overlay reports run outcomes itself, so the sheet is only
          for messages raised outside a run. */}
      <Browser ref={browserRef} onRunFinished={() => setHint('')} />

      <StatusSheet message={hint} onDismiss={() => setHint('')} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  /**
   * The tab bar floats, so the browser reserves its height rather than letting
   * the frosted bar cover the bottom of live web pages.
   */
  root: { flex: 1, backgroundColor: colors.bg, paddingBottom: TAB_BAR_HEIGHT },
});
