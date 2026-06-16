import { Capacitor } from '@capacitor/core';

let permissionGranted = false;
let permissionPromise: Promise<void> | null = null;
let swRegistration: ServiceWorkerRegistration | null = null;

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/** Request OS/browser notification permission once. Returns the shared promise
 *  so callers can await the grant before acting on it (e.g. Web Push needs
 *  permission resolved before it can subscribe). */
export function requestNotificationPermission(): Promise<void> {
  if (!permissionPromise) permissionPromise = doRequestPermission();
  return permissionPromise;
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
    if (permissionGranted && 'serviceWorker' in navigator) {
      try {
        swRegistration = await navigator.serviceWorker.register(
          new URL('/sw-notify.js', import.meta.url).href,
        );
      } catch {
        // SW optional — falls back to new Notification()
      }
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
  } else if (swRegistration) {
    try {
      await swRegistration.showNotification(title, { body });
    } catch (err) {
      console.error('Failed to show notification via SW:', err);
    }
  } else {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }
}
