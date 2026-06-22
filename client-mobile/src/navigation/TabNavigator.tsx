import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Chat } from '../screens/Chat';
import { AppointmentList } from '../screens/AppointmentList';
import { Notifications } from '../screens/Notifications';
import { SettingsScreen } from '../screens/SettingsScreen';

export type TabParamList = {
  Chat: undefined;
  Appointments: undefined;
  Notifications: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator<TabParamList>();

export function TabNavigator() {
  return (
    <Tab.Navigator screenOptions={{ headerShown: false }}>
      <Tab.Screen name="Chat"          component={Chat} />
      <Tab.Screen name="Appointments"  component={AppointmentList} />
      <Tab.Screen name="Notifications" component={Notifications} />
      <Tab.Screen name="Settings"      component={SettingsScreen} />
    </Tab.Navigator>
  );
}
