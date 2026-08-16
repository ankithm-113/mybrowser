import React, { useEffect, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import DialogHost from '@/components/DialogHost';
import Icon, { IconName } from '@/components/Icon';
import { colors, palette, space, type } from '@/components/theme';
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
  return (
    <View style={[styles.tabIcon, focused && styles.tabIconFocused]}>
      <Icon
        name={TAB_ICONS[name] ?? 'globe'}
        size={20}
        color={focused ? colors.onFill : colors.textDim}
        bg={focused ? colors.fill : colors.surface}
      />
    </View>
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
        <Tab.Navigator
          screenOptions={({ route }) => ({
            headerShown: false,
            tabBarStyle: styles.tabBar,
            tabBarActiveTintColor: colors.text,
            tabBarInactiveTintColor: colors.textDim,
            tabBarLabelStyle: styles.tabLabel,
            tabBarItemStyle: styles.tabItem,
            tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
          })}
        >
          <Tab.Screen name="Agent" component={BrowserScreen} />
          <Tab.Screen name="Vault" component={VaultScreen} />
          <Tab.Screen name="Jobs" component={JobReviewScreen} />
          <Tab.Screen name="Settings" component={SettingsScreen} />
        </Tab.Navigator>
      </NavigationContainer>

      {/* Mounted above the navigator so dialogs render over every screen. */}
      <DialogHost />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    height: Platform.OS === 'ios' ? 88 : 68,
    paddingBottom: Platform.OS === 'ios' ? 28 : 10,
    paddingTop: space.sm,
    elevation: 0,
  },
  tabItem: { paddingTop: 2 },
  tabLabel: { ...type.micro, marginTop: 2 },
  tabIcon: {
    width: 46,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIconFocused: { backgroundColor: colors.fill },
});
