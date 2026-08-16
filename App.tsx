import React, { useEffect, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import DialogHost from '@/components/DialogHost';
import Glass from '@/components/Glass';
import Icon, { IconName } from '@/components/Icon';
import {
  FLOATING_BAR_HEIGHT,
  FLOATING_BAR_MARGIN,
  FLOATING_BAR_RADIUS,
} from '@/components/layout';
import { colors, palette, radius, space, type } from '@/components/theme';
import BrowserScreen from '@/screens/BrowserScreen';
import JobReviewScreen from '@/screens/JobReviewScreen';
import SettingsScreen from '@/screens/SettingsScreen';
import VaultScreen from '@/screens/VaultScreen';
import { configureScheduler, runJobSweep } from '@/services/jobScheduler';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

const Tab = createBottomTabNavigator();

const navTheme = {
  ...DefaultTheme,
  dark: false,
  colors: {
    ...DefaultTheme.colors,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.fill,
    notification: colors.fill,
  },
};

const TAB_ICONS: Record<string, IconName> = {
  Agent: 'globe',
  Vault: 'vault',
  Jobs: 'target',
  Settings: 'sliders',
};

/**
 * Active tab is marked by a filled pill behind the glyph — with no colour
 * available, fill is what carries the selected state.
 */
function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const glyph = (
    <Icon
      name={TAB_ICONS[name] ?? 'globe'}
      size={20}
      color={focused ? palette.white : colors.textDim}
      bg={focused ? palette.gray800 : 'transparent'}
    />
  );

  // Selected tab is a smoked-glass capsule rather than a flat black block.
  return focused ? (
    <Glass tone="dark" intensity={55} radiusSize={radius.pill} style={styles.tabIcon}>
      {glyph}
    </Glass>
  ) : (
    <View style={styles.tabIcon}>{glyph}</View>
  );
}

export default function App() {
  const navRef = useRef<any>(null);

  useEffect(() => {
    // Register the daily notification + background fetch on every cold start.
    void configureScheduler();

    // The scheduled sweep notification is also the trigger: when it lands while
    // the app is alive, run the sweep immediately.
    const received = Notifications.addNotificationReceivedListener((notification) => {
      if (notification.request.content.data?.action === 'sweep') void runJobSweep();
    });

    const responded = Notifications.addNotificationResponseReceivedListener((response) => {
      const target = response.notification.request.content.data?.screen;
      if (target === 'JobReview') navRef.current?.navigate('Jobs');
    });

    return () => {
      received.remove();
      responded.remove();
    };
  }, []);

  return (
    <SafeAreaProvider>
      {/* Dark glyphs on the light background, with a matching opaque backdrop
          on Android so the bar is never white-on-white. */}
      <StatusBar style="dark" backgroundColor={palette.white} translucent={false} />
      <NavigationContainer ref={navRef} theme={navTheme}>
        <Tabs />
      </NavigationContainer>

      {/* Mounted above the navigator so dialogs render over every screen. */}
      <DialogHost />
    </SafeAreaProvider>
  );
}

/**
 * Split out so it can read safe-area insets, which are only available inside
 * SafeAreaProvider. The bar sits above the gesture bar rather than under it.
 */
function Tabs() {
  const insets = useSafeAreaInsets();
  const bottom = Math.max(insets.bottom, 6) + FLOATING_BAR_MARGIN;

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: [styles.tabBar, { bottom }],
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.textDim,
        tabBarLabelStyle: styles.tabLabel,
        tabBarItemStyle: styles.tabItem,
        // Detached, transparent bar so content scrolls visibly under the glass.
        tabBarBackground: () => (
          <Glass
            tone="light"
            intensity={75}
            radiusSize={FLOATING_BAR_RADIUS}
            style={StyleSheet.absoluteFill as any}
          />
        ),
        tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
      })}
    >
      <Tab.Screen name="Agent" component={BrowserScreen} />
      <Tab.Screen name="Vault" component={VaultScreen} />
      <Tab.Screen name="Jobs" component={JobReviewScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  /** Detached slab: inset from every edge, rounded, with a soft neutral shadow. */
  tabBar: {
    position: 'absolute',
    left: FLOATING_BAR_MARGIN,
    right: FLOATING_BAR_MARGIN,
    height: FLOATING_BAR_HEIGHT,
    backgroundColor: 'transparent',
    borderTopWidth: 0,
    borderRadius: FLOATING_BAR_RADIUS,
    paddingBottom: space.sm,
    paddingTop: space.sm,
    shadowColor: palette.black,
    shadowOpacity: 0.14,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  tabItem: { paddingTop: 2 },
  tabLabel: { ...type.micro, marginTop: 3 },
  tabIcon: {
    width: 46,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
