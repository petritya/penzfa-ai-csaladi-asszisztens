import OneSignal from 'react-onesignal'

let initPromise: Promise<void> | null = null

export function isPushConfigured() {
  return Boolean(import.meta.env.VITE_ONESIGNAL_APP_ID)
}

export async function initializePush(userId: string) {
  const appId = import.meta.env.VITE_ONESIGNAL_APP_ID
  if (!appId) return false

  if (!initPromise) {
    initPromise = OneSignal.init({
      appId,
      allowLocalhostAsSecureOrigin: true,
      serviceWorkerPath: '/push/onesignal/OneSignalSDKWorker.js',
      serviceWorkerParam: { scope: '/push/onesignal/' },
    })
  }

  await initPromise
  await OneSignal.login(userId)
  return true
}

export async function requestPushPermission() {
  if (!isPushConfigured()) return false
  await initPromise
  return OneSignal.Notifications.requestPermission()
}

export async function logoutPush() {
  if (!isPushConfigured() || !initPromise) return
  await initPromise
  await OneSignal.logout()
}
