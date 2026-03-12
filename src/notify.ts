import { Capacitor } from '@capacitor/core';

let permissionGranted = false;
let permissionPromise: Promise<void> | null = null;
let activeNotification: Notification | null = null;

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export function requestNotificationPermission(): void {
  if (permissionPromise) return;
  permissionPromise = doRequestPermission();
}

async function doRequestPermission(): Promise<void> {
  if (isNative()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const result = await LocalNotifications.requestPermissions();
      permissionGranted = result.display === 'granted';
    } catch (err) {
      console.error('Failed to request notification permission:', err);
    }
  } else if ('Notification' in window) {
    try {
      const result = await Notification.requestPermission();
      permissionGranted = result === 'granted';
    } catch (err) {
      console.error('Failed to request notification permission:', err);
    }
  }
}

export async function notify(title: string, body: string): Promise<void> {
  if (permissionPromise) await permissionPromise;
  if (!permissionGranted || document.visibilityState === 'visible') return;

  if (isNative()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await LocalNotifications.schedule({
        notifications: [{ title, body, id: Date.now() }],
      });
    } catch (err) {
      console.error('Failed to schedule notification:', err);
    }
  } else if ('Notification' in window) {
    activeNotification?.close();
    activeNotification = new Notification(title, { body });
    activeNotification.onclick = () => {
      window.focus();
      activeNotification?.close();
      activeNotification = null;
    };
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && activeNotification) {
    activeNotification.close();
    activeNotification = null;
  }
});
