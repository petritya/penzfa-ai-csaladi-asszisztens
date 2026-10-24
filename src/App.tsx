import { FormEvent, useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { hasSupabaseConfig, supabase } from './lib/supabase'
import { authErrorText, detectAppLocale, detectDeviceTimezone, rememberAppLocale, uiText } from './lib/locale'
import type { AppLocale } from './lib/locale'
import { translateUi } from './lib/ui-copy'
import DanishHelp from './DanishHelp'

type AuthMode = 'sign-in' | 'sign-up'
type AppearanceMode = 'system' | 'light' | 'dark'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed'
    platform: string
  }>
}

type FamilyMember = {
  id: string
  family_id: string
  user_id: string | null
  display_name: string
  member_kind: 'active' | 'managed'
}

type CreateDraft = {
  subject_member_id: string | null
  subject_display_name: string | null
  responsible_user_id: string
  responsible_display_name: string
  title: string
  item_type: 'task' | 'event' | 'deadline'
  notes: string | null
  due_date: string | null
  due_time: string | null
  first_reminder_at: string | null
  reminder_phrase: string | null
  confirmation_text: string
}

type CompleteDraft = {
  pending_action_id: string
  target_item_id: string
  confirmation_text: string
}

type CompleteCandidate = {
  id: string
  title: string
  label: string
  due_date: string | null
  due_time: string | null
  responsible_display_name: string | null
  subject_display_name: string | null
  item_type?: 'task' | 'event' | 'deadline'
}

type UpdateDraft = {
  pending_action_id: string
  target_item_id: string
  confirmation_text: string
}

type DeleteDraft = {
  pending_action_id: string
  target_item_id: string
  confirmation_text: string
}

type ReminderEditTarget = {
  id: string
  title: string
}

type ReminderFollowUp = ReminderEditTarget & {
  reminder_at: string | null
}

type PushStatus = 'idle' | 'loading' | 'ready' | 'enabled' | 'blocked' | 'unsupported' | 'error'

type UserSettings = {
  timezone: string
  ui_locale: AppLocale | null
  briefing_enabled: boolean
  briefing_time: string
  notify_partner_on_complete: boolean
}

type PushContext = {
  type: 'briefing' | 'reminder' | 'item'
  title: string
  message: string
  item_id: string | null
  item_title: string | null
}

type QueryResultItem = {
  id: string
  title: string
  label: string
  status: 'open' | 'done' | 'deleted'
  due_date: string | null
  due_time: string | null
  reminder_at?: string | null
  reminder_missing?: boolean
  subject_display_name: string | null
  subject_member_kind: 'active' | 'managed' | null
  responsible_display_name: string | null
  is_other_owner: boolean
  is_overdue: boolean
}

type OneSignalClient = {
  init: (options: {
    appId: string
    serviceWorkerPath: string
    serviceWorkerParam: { scope: string }
    welcomeNotification?: {
      disable: boolean
    }
  }) => Promise<void>
  login: (externalId: string) => Promise<void> | void
  logout: () => Promise<void> | void
  Notifications: {
    requestPermission: () => Promise<void>
  }
  User: {
    PushSubscription: {
      id: string | null | undefined
      token: string | null | undefined
      optedIn: boolean
      optIn: () => Promise<void>
    }
  }
}

type OneSignalWindow = Window & {
  OneSignalDeferred?: Array<(client: OneSignalClient) => void | Promise<void>>
}

let oneSignalClientPromise: Promise<OneSignalClient> | null = null

function getOneSignalClient(appId: string) {
  if (oneSignalClientPromise) return oneSignalClientPromise

  oneSignalClientPromise = new Promise<OneSignalClient>((resolve, reject) => {
    const oneSignalWindow = window as OneSignalWindow
    oneSignalWindow.OneSignalDeferred = oneSignalWindow.OneSignalDeferred ?? []

    oneSignalWindow.OneSignalDeferred.push(async (oneSignal) => {
      try {
        await oneSignal.init({
          appId,
          serviceWorkerPath: 'OneSignalSDKWorker.js',
          serviceWorkerParam: { scope: '/' },
          welcomeNotification: {
            disable: true,
          },
        })
        resolve(oneSignal)
      } catch (error) {
        oneSignalClientPromise = null
        reject(error)
      }
    })

    if (!document.querySelector('script[data-onesignal-sdk]')) {
      const script = document.createElement('script')
      script.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js'
      script.defer = true
      script.dataset.onesignalSdk = 'true'
      script.onerror = () => {
        oneSignalClientPromise = null
        reject(new Error('A OneSignal SDK nem tölthető be.'))
      }
      document.head.appendChild(script)
    }
  })

  return oneSignalClientPromise
}

async function waitForPushSubscription(oneSignal: OneSignalClient) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const subscription = oneSignal.User.PushSubscription
    if (subscription.optedIn && subscription.id && subscription.token?.trim()) return true
    await new Promise((resolve) => window.setTimeout(resolve, 300))
  }

  return false
}

function greetingForHour(hour: number, locale: AppLocale) {
  if (hour < 10) return uiText(locale, 'greetingMorning')
  if (hour < 18) return uiText(locale, 'greetingDay')
  return uiText(locale, 'greetingEvening')
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loadingSession, setLoadingSession] = useState(hasSupabaseConfig)
  const [mode, setMode] = useState<AuthMode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null)
  const [resendBusy, setResendBusy] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [resendMessage, setResendMessage] = useState<string | null>(null)
  const [emailJustConfirmed, setEmailJustConfirmed] = useState(() =>
    new URLSearchParams(window.location.search).get('email_confirmed') === '1',
  )
  const [authRedirectError] = useState(() => {
    const search = new URLSearchParams(window.location.search)
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const hasError = Boolean(
      search.get('error')
      || search.get('error_code')
      || hash.get('error')
      || hash.get('error_code'),
    )

    return hasError
      ? 'A megerősítő link lejárt vagy már nem érvényes. Ha több levelet kaptál, mindig a legfrissebb levél linkjét használd.'
      : null
  })

  const [familyLoading, setFamilyLoading] = useState(false)
  const [familyName, setFamilyName] = useState<string | null>(null)
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([])
  const [familyError, setFamilyError] = useState<string | null>(null)
  const [familyRefreshKey, setFamilyRefreshKey] = useState(0)

  const [setupFamilyName, setSetupFamilyName] = useState('')
  const [setupDisplayName, setSetupDisplayName] = useState('')
  const [setupManagedMembers, setSetupManagedMembers] = useState('')
  const [setupSecondOwnerEmail, setSetupSecondOwnerEmail] = useState('')
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [setupMessage, setSetupMessage] = useState<string | null>(null)

  const [newFamilyMemberName, setNewFamilyMemberName] = useState('')
  const [secondOwnerInviteEmail, setSecondOwnerInviteEmail] = useState('')
  const [familyActionBusy, setFamilyActionBusy] = useState(false)
  const [familyActionError, setFamilyActionError] = useState<string | null>(null)
  const [familyActionMessage, setFamilyActionMessage] = useState<string | null>(null)
  const [pendingOwnerInvitation, setPendingOwnerInvitation] = useState(false)
  const [invitationFamilyName, setInvitationFamilyName] = useState<string | null>(null)
  const [invitationDisplayName, setInvitationDisplayName] = useState('')
  const [invitationPassword, setInvitationPassword] = useState('')
  const [invitationBusy, setInvitationBusy] = useState(false)
  const [invitationError, setInvitationError] = useState<string | null>(null)

  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isStandalone, setIsStandalone] = useState(() => {
    const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean }
    return window.matchMedia('(display-mode: standalone)').matches
      || navigatorWithStandalone.standalone === true
  })
  const isIos = /iPad|iPhone|iPod/i.test(window.navigator.userAgent)
    || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1)

  const [pushStatus, setPushStatus] = useState<PushStatus>('idle')
  const [pushAppId, setPushAppId] = useState<string | null>(null)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)

  const [appLocale, setAppLocale] = useState<AppLocale>(detectAppLocale)
  const [deviceTimezone] = useState(detectDeviceTimezone)

  useEffect(() => {
    rememberAppLocale(appLocale)
  }, [appLocale])

  useEffect(() => {
    document.documentElement.lang = appLocale === 'da-DK' ? 'da' : 'hu'
  }, [appLocale])
  const [localeBusy, setLocaleBusy] = useState(false)
  const [localeMessage, setLocaleMessage] = useState<string | null>(null)
  const [localeError, setLocaleError] = useState<string | null>(null)
  const t = (key: Parameters<typeof uiText>[1]) => uiText(appLocale, key)
  const tr = (hungarian: string) => translateUi(appLocale, hungarian)

  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const settingsSavingRef = useRef(false)
  const [settings, setSettings] = useState<UserSettings>({
    timezone: 'Europe/Budapest',
    ui_locale: null,
    briefing_enabled: true,
    briefing_time: '07:00',
    notify_partner_on_complete: false,
  })
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(() => {
    const saved = window.localStorage.getItem('penzfa-appearance')
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
  })

  const [createMessage, setCreateMessage] = useState('')
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createSuccess, setCreateSuccess] = useState<string | null>(null)
  const [completeDraft, setCompleteDraft] = useState<CompleteDraft | null>(null)
  const [completeCandidates, setCompleteCandidates] = useState<CompleteCandidate[]>([])
  const [updateDraft, setUpdateDraft] = useState<UpdateDraft | null>(null)
  const [reminderUpdateDraft, setReminderUpdateDraft] = useState<UpdateDraft | null>(null)
  const [reminderEditTarget, setReminderEditTarget] = useState<ReminderEditTarget | null>(null)
  const [dateEditTarget, setDateEditTarget] = useState<ReminderEditTarget | null>(null)
  const [reminderFollowUp, setReminderFollowUp] = useState<ReminderFollowUp | null>(null)
  const [deleteDraft, setDeleteDraft] = useState<DeleteDraft | null>(null)
  const [assistantAnswer, setAssistantAnswer] = useState<string | null>(null)
  const [queryResults, setQueryResults] = useState<QueryResultItem[]>([])
  const [voiceListening, setVoiceListening] = useState(false)
  const [voiceTranscribing, setVoiceTranscribing] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [pushContext, setPushContext] = useState<PushContext | null>(null)
  const [localizedPush, setLocalizedPush] = useState<{
    source: string
    locale: AppLocale
    title: string
    lines: string[]
  } | null>(null)
  const [pushContextLoading, setPushContextLoading] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  useEffect(() => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaRecorderRef.current = null
    mediaStreamRef.current = null
    audioChunksRef.current = []

    setCreateMessage('')
    setCreateDraft(null)
    setCompleteDraft(null)
    setCompleteCandidates([])
    setUpdateDraft(null)
    setReminderUpdateDraft(null)
    setReminderEditTarget(null)
    setDateEditTarget(null)
    setReminderFollowUp(null)
    setDeleteDraft(null)
    setCreateError(null)
    setCreateSuccess(null)
    setAssistantAnswer(null)
    setQueryResults([])
    setVoiceListening(false)
    setVoiceTranscribing(false)
    setVoiceError(null)
    setPushContext(null)
    setPushContextLoading(false)
  }, [session?.user.id])

  useEffect(() => {
    document.documentElement.lang = appLocale
  }, [appLocale])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const applyAppearance = () => {
      const resolved = appearanceMode === 'system'
        ? media.matches ? 'dark' : 'light'
        : appearanceMode

      document.documentElement.dataset.theme = resolved
      window.localStorage.setItem('penzfa-appearance', appearanceMode)

      const themeMeta = document.querySelector('meta[name="theme-color"]')
      themeMeta?.setAttribute('content', resolved === 'dark' ? '#0b1220' : '#f1f5f4')
    }

    applyAppearance()

    if (appearanceMode !== 'system') return

    media.addEventListener('change', applyAppearance)
    return () => media.removeEventListener('change', applyAppearance)
  }, [appearanceMode])

  useEffect(() => {
    if (!supabase) return

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoadingSession(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setLoadingSession(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    const displayMode = window.matchMedia('(display-mode: standalone)')

    const syncStandaloneState = () => {
      const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean }
      setIsStandalone(
        displayMode.matches || navigatorWithStandalone.standalone === true,
      )
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
    }

    const handleAppInstalled = () => {
      setInstallPrompt(null)
      setIsStandalone(true)
    }

    syncStandaloneState()
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)
    displayMode.addEventListener('change', syncStandaloneState)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
      displayMode.removeEventListener('change', syncStandaloneState)
    }
  }, [])

  useEffect(() => {
    if (!authRedirectError) return

    window.history.replaceState({}, '', window.location.pathname)
  }, [authRedirectError])

  useEffect(() => {
    if (resendCooldown <= 0) return

    const timer = window.setInterval(() => {
      setResendCooldown((current) => Math.max(0, current - 1))
    }, 1000)

    return () => window.clearInterval(timer)
  }, [resendCooldown])

  useEffect(() => {
    if (!familyActionMessage) return

    const timer = window.setTimeout(() => {
      setFamilyActionMessage(null)
    }, 5000)

    return () => window.clearTimeout(timer)
  }, [familyActionMessage])

  useEffect(() => {
    if (!createSuccess) return

    const timer = window.setTimeout(() => {
      setCreateSuccess(null)
    }, 4500)

    return () => window.clearTimeout(timer)
  }, [createSuccess])

  useEffect(() => {
    if (!settingsMessage) return

    const timer = window.setTimeout(() => {
      setSettingsMessage(null)
    }, 4500)

    return () => window.clearTimeout(timer)
  }, [settingsMessage])

  useEffect(() => {
    if (!session || !emailJustConfirmed) return

    const url = new URL(window.location.href)
    url.searchParams.delete('email_confirmed')
    window.history.replaceState(
      {},
      '',
      `${url.pathname}${url.search}${url.hash}`,
    )

    const timer = window.setTimeout(() => {
      setEmailJustConfirmed(false)
    }, 5000)

    return () => window.clearTimeout(timer)
  }, [session, emailJustConfirmed])

  useEffect(() => {
    const client = supabase

    if (!client || !session) {
      setFamilyName(null)
      setFamilyMembers([])
      setFamilyError(null)
      return
    }

    let cancelled = false

    async function loadFamily(activeClient: NonNullable<typeof supabase>) {
      setFamilyLoading(true)
      setFamilyError(null)

      const { data: members, error: membersError } = await activeClient
        .from('family_members')
        .select('id, family_id, user_id, display_name, member_kind, created_at')
        .order('created_at', { ascending: true })

      if (cancelled) return

      if (membersError) {
        setFamilyError(membersError.message)
        setFamilyLoading(false)
        return
      }

      if (!members || members.length === 0) {
        setFamilyName(null)
        setFamilyMembers([])

        const { data: setupStatus, error: setupStatusError } = await activeClient.functions.invoke('core', {
          body: { action: 'setup_status' },
        })

        if (cancelled) return

        if (setupStatusError) {
          setFamilyError(setupStatusError.message)
          setFamilyLoading(false)
          return
        }

        setPendingOwnerInvitation(Boolean(setupStatus?.pending_owner_invitation))
        setInvitationFamilyName(setupStatus?.invitation_family_name ?? null)
        setFamilyLoading(false)
        return
      }

      const familyId = members[0].family_id

      const { data: family, error: familyErrorResult } = await activeClient
        .from('families')
        .select('name')
        .eq('id', familyId)
        .single()

      if (cancelled) return

      if (familyErrorResult || !family) {
        setFamilyError(familyErrorResult?.message ?? 'A család adatai nem tölthetők be.')
        setFamilyLoading(false)
        return
      }

      setPendingOwnerInvitation(false)
      setInvitationFamilyName(null)
      setFamilyName(family.name)
      setFamilyMembers(
        members
          .filter((member) => member.family_id === familyId)
          .map(({ id, family_id, user_id, display_name, member_kind }) => ({
            id,
            family_id,
            user_id,
            display_name,
            member_kind,
          })),
      )
      setFamilyLoading(false)
    }

    loadFamily(client)

    return () => {
      cancelled = true
    }
  }, [session, familyRefreshKey])

  useEffect(() => {
    if (!supabase || !session || !familyName) return

    const url = new URL(window.location.href)
    const pushType = url.searchParams.get('push')
    if (pushType !== 'briefing' && pushType !== 'reminder' && pushType !== 'item') return
    const resolvedPushType: PushContext['type'] = pushType

    const briefingDate = url.searchParams.get('date')
    const itemId = url.searchParams.get('item_id')
    let cancelled = false

    async function loadPushContext() {
      setPushContextLoading(true)

      const { data, error } = await supabase!.functions.invoke('core', {
        body: {
          action: 'push_context',
          type: resolvedPushType,
          briefing_date: briefingDate,
          item_id: itemId,
        },
      })

      if (cancelled) return
      setPushContextLoading(false)

      if (!error && data?.status === 'ok' && data?.message) {
        setPushContext({
          type: resolvedPushType,
          title: String(
            data.title
            ?? (resolvedPushType === 'briefing' ? 'Reggeli briefing' : resolvedPushType === 'reminder' ? 'Emlékeztető' : 'Ügy'),
          ),
          message: String(data.message),
          item_id: data.item_id ? String(data.item_id) : null,
          item_title: data.item_title ? String(data.item_title) : null,
        })
      }

      url.searchParams.delete('push')
      url.searchParams.delete('date')
      url.searchParams.delete('item_id')
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    }

    void loadPushContext()

    return () => {
      cancelled = true
    }
  }, [session?.user.id, familyName])

  // A már mentett briefing-szöveg a nyelvváltás után is az aktuális
  // felhasználói nyelven jelenik meg. A forrás és minden ügyadat változatlan.
  useEffect(() => {
    if (!supabase || !session || !pushContext) {
      setLocalizedPush(null)
      return
    }
    let cancelled = false
    setLocalizedPush(null)
    const sourceLines = pushContext.message.split('\n').map((line) => line.trim()).filter(Boolean)
    const prefixPattern = /^(Ma|Lejárt|Emlékeztető):\s*(.*)$/
    const bodyTexts = pushContext.type === 'briefing'
      ? sourceLines.map((line) => line.match(prefixPattern)?.[2] ?? line)
      : [pushContext.message]
    const inputs = [pushContext.title, ...bodyTexts]

    async function localize() {
      const translated: string[] = []
      for (let offset = 0; offset < inputs.length; offset += 10) {
        const { data, error } = await supabase!.functions.invoke('core', {
          body: {
            action: 'localize_display_text',
            ui_locale: appLocale,
            texts: inputs.slice(offset, offset + 10),
          },
        })
        if (cancelled) return
        if (error || !Array.isArray(data?.translations)
          || data.translations.length !== Math.min(10, inputs.length - offset)) {
          return
        }
        translated.push(...data.translations)
      }
      if (cancelled) return
      const lines = pushContext!.type === 'briefing'
        ? sourceLines.map((line, i) => {
          const match = line.match(prefixPattern)
          return match ? `${match[1]}: ${translated[i + 1]}` : translated[i + 1]
        })
        : [translated[1]]
      setLocalizedPush({
        source: pushContext!.message,
        locale: appLocale,
        title: translated[0],
        lines,
      })
    }
    void localize().catch(() => { /* Marad az eredeti szöveg. */ })
    return () => { cancelled = true }
  }, [session?.user.id, pushContext, appLocale])

  useEffect(() => {
    if (!supabase || !session || !familyName) {
      setPushStatus('idle')
      setPushAppId(null)
      setPushError(null)
      return
    }

    let cancelled = false

    async function preparePush() {
      if (typeof Notification === 'undefined') {
        if (!cancelled) setPushStatus('unsupported')
        return
      }

      setPushStatus('loading')
      setPushError(null)

      const { data: authData } = await supabase!.auth.getSession()
      const currentSession = authData.session

      if (cancelled) return

      if (!currentSession) {
        setPushStatus('error')
        setPushError('Nincs aktív munkamenet. Jelentkezz be újra.')
        return
      }

      const { data, error } = await supabase!.functions.invoke('core', {
        body: { action: 'push_config' },
        headers: {
          Authorization: `Bearer ${currentSession.access_token}`,
        },
      })

      if (cancelled) return

      if (error || !data?.enabled || !data?.app_id) {
        setPushStatus('error')
        setPushError(error?.message ?? data?.error ?? 'A push szolgáltatás nem érhető el.')
        return
      }

      setPushAppId(data.app_id)

      try {
        const oneSignal = await getOneSignalClient(data.app_id)

        // A login a most bejelentkezett fiókhoz rendeli az eszközt;
        // kijelentkeztetni csak tényleges fiókból kilépéskor szükséges.
        await oneSignal.login(currentSession.user.id)

        if (cancelled) return

        if (Notification.permission === 'denied') {
          setPushStatus('blocked')
        } else if (Notification.permission === 'granted') {
          if (!oneSignal.User.PushSubscription.optedIn) {
            await oneSignal.User.PushSubscription.optIn()
          }

          // Az opt-in létrehozhat/frissíthet subscriptiont, ezért utána
          // még egyszer rögzítjük az aktuális felhasználói kapcsolatot.
          await oneSignal.login(currentSession.user.id)

          const subscribed = await waitForPushSubscription(oneSignal)
          if (cancelled) return
          setPushStatus(subscribed ? 'enabled' : 'ready')
        } else {
          setPushStatus('ready')
        }
      } catch (error) {
        if (cancelled) return
        setPushStatus('error')
        setPushError(error instanceof Error ? error.message : 'A push inicializálása nem sikerült.')
      }
    }

    preparePush()

    return () => {
      cancelled = true
    }
  }, [session?.user.id, familyName])

  useEffect(() => {
    const currentSession = session
    const currentPushAppId = pushAppId

    if (!currentSession || !currentPushAppId) return

    const resolvedPushAppId: string = currentPushAppId
    const currentUserId: string = currentSession.user.id
    let cancelled = false

    async function relinkPushOnResume() {
      if (document.visibilityState !== 'visible') return

      try {
        const oneSignal = await getOneSignalClient(resolvedPushAppId)
        await oneSignal.login(currentUserId)

        if (
          !cancelled
          && typeof Notification !== 'undefined'
          && Notification.permission === 'granted'
        ) {
          if (!oneSignal.User.PushSubscription.optedIn) {
            await oneSignal.User.PushSubscription.optIn()
          }
          await oneSignal.login(currentUserId)
          const subscribed = await waitForPushSubscription(oneSignal)
          if (!cancelled) {
            setPushStatus(subscribed ? 'enabled' : 'ready')
          }
        }
      } catch {
        // A háttérből visszatéréskor végzett push-helyreállítás
        // nem blokkolhatja az alkalmazás használatát.
      }
    }

    document.addEventListener('visibilitychange', relinkPushOnResume)
    void relinkPushOnResume()

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', relinkPushOnResume)
    }
  }, [session?.user.id, pushAppId])

  useEffect(() => {
    if (!supabase || !session || !familyName) {
      setSettings({
        timezone: 'Europe/Budapest',
        ui_locale: null,
        briefing_enabled: true,
        briefing_time: '07:00',
        notify_partner_on_complete: false,
      })
      setAppLocale(detectAppLocale())
      setSettingsError(null)
      setSettingsMessage(null)
      return
    }

    let cancelled = false

    async function loadSettings() {
      setSettingsLoading(true)
      setSettingsError(null)

      const { data, error } = await supabase!.functions.invoke('core', {
        body: { action: 'get_settings' },
      })

      if (cancelled) return

      setSettingsLoading(false)

      if (error || !data?.settings) {
        setSettingsError(error?.message ?? data?.error ?? 'A beállítások nem tölthetők be.')
        return
      }

      const hasSavedLocale = data.settings.ui_locale === 'da-DK' || data.settings.ui_locale === 'hu-HU'
      const locale: AppLocale = hasSavedLocale ? data.settings.ui_locale as AppLocale : detectAppLocale()
      // Régebbi, automatikus nyelvű fióknál egyszer rögzítjük a készülék
      // által jelzett nyelvet, hogy az ütemezett briefing is tudja a célnyelvet.
      // A már kézzel mentett nyelvet soha nem írjuk felül.
      if (!hasSavedLocale) {
        const { error: localeSaveError } = await supabase!.functions.invoke('core', {
          body: { action: 'update_locale_preferences', ui_locale: locale },
        })
        if (cancelled) return
        if (localeSaveError) {
          setSettingsError(uiText(locale, 'localeError'))
        }
      }
      setAppLocale(locale)
      setSettings({
        timezone: String(data.settings.timezone ?? 'Europe/Budapest'),
        ui_locale: locale,
        briefing_enabled: Boolean(data.settings.briefing_enabled),
        briefing_time: String(data.settings.briefing_time ?? '07:00').slice(0, 5),
        notify_partner_on_complete: Boolean(data.settings.notify_partner_on_complete),
      })
    }

    loadSettings()

    return () => {
      cancelled = true
    }
  }, [session?.user.id, familyName])

  async function handleEnablePush() {
    if (!session || !pushAppId) return

    setPushBusy(true)
    setPushError(null)

    try {
      const oneSignal = await getOneSignalClient(pushAppId)
      await oneSignal.login(session.user.id)
      await oneSignal.Notifications.requestPermission()

      if (Notification.permission === 'denied') {
        setPushStatus('blocked')
        return
      }

      if (Notification.permission !== 'granted') {
        setPushStatus('ready')
        return
      }

      await oneSignal.User.PushSubscription.optIn()
      await oneSignal.login(session.user.id)

      const subscribed = await waitForPushSubscription(oneSignal)
      if (subscribed) {
        setPushStatus('enabled')
      } else {
        setPushStatus('ready')
        setPushError(
          'Ezen az eszközön még nem működnek az értesítések. Próbáld meg újra a bekapcsolást.',
        )
      }
    } catch (error) {
      setPushStatus('error')
      setPushError(error instanceof Error ? error.message : 'Az értesítések bekapcsolása nem sikerült.')
    } finally {
      setPushBusy(false)
    }
  }

  async function saveSettingChange(
    change: Partial<Pick<UserSettings, 'briefing_enabled' | 'briefing_time' | 'notify_partner_on_complete'>>,
  ) {
    if (!supabase || !session || !familyName || settingsSavingRef.current) return

    const previous = settings
    const next = { ...previous, ...change }
    // A natív időválasztó szerkesztés közben üres értéket is adhat.
    // Csak teljes, érvényes időpontot mentünk.
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.briefing_time)) return

    settingsSavingRef.current = true
    setSettingsBusy(true)
    setSettings(next)
    setSettingsError(null)
    setSettingsMessage(null)

    try {
      const { data, error } = await supabase.functions.invoke('core', {
        body: {
          action: 'update_settings',
          briefing_enabled: next.briefing_enabled,
          briefing_time: next.briefing_time,
          notify_partner_on_complete: next.notify_partner_on_complete,
        },
      })

      if (error || data?.error || !data?.settings) {
        throw new Error(error?.message ?? data?.error ?? uiText(appLocale, 'saveError'))
      }

      setSettings((current) => ({
        ...current,
        briefing_enabled: Boolean(data.settings.briefing_enabled),
        briefing_time: String(data.settings.briefing_time ?? next.briefing_time).slice(0, 5),
        notify_partner_on_complete: Boolean(data.settings.notify_partner_on_complete),
      }))
      setSettingsMessage(uiText(appLocale, 'saved'))
    } catch (error) {
      // Csak a három mentett mezőt állítjuk vissza; a nyelv és
      // az időzóna egy másik, független mentési folyamat része.
      setSettings((current) => ({
        ...current,
        briefing_enabled: previous.briefing_enabled,
        briefing_time: previous.briefing_time,
        notify_partner_on_complete: previous.notify_partner_on_complete,
      }))
      setSettingsError(error instanceof Error ? error.message : uiText(appLocale, 'saveError'))
    } finally {
      settingsSavingRef.current = false
      setSettingsBusy(false)
    }
  }

  async function handleLocalePreference(locale: AppLocale, useDeviceTimezone = false) {
    if (!supabase || !session || !familyName || localeBusy) return
    if (useDeviceTimezone && !deviceTimezone) return

    const previousLocale = appLocale
    if (!useDeviceTimezone) setAppLocale(locale)
    setLocaleBusy(true)
    setLocaleError(null)
    setLocaleMessage(null)

    try {
      const { data, error } = await supabase.functions.invoke('core', {
        body: {
          action: 'update_locale_preferences',
          ui_locale: locale,
          ...(useDeviceTimezone && deviceTimezone ? { timezone: deviceTimezone } : {}),
        },
      })
      if (error || data?.error) throw new Error(error?.message ?? data?.error ?? uiText(locale, 'localeError'))
      await supabase.auth.updateUser({
        data: { ui_locale: locale },
      })
      setAppLocale(locale)
      setSettings((current) => ({
        ...current,
        ui_locale: locale,
        timezone: String(data.settings?.timezone ?? current.timezone),
      }))
      setLocaleMessage(uiText(locale, useDeviceTimezone ? 'timezoneSaved' : 'localeSaved'))
    } catch (error) {
      if (!useDeviceTimezone) setAppLocale(previousLocale)
      setLocaleError(error instanceof Error ? error.message : uiText(previousLocale, useDeviceTimezone ? 'timezoneError' : 'localeError'))
    } finally {
      setLocaleBusy(false)
    }
  }

  async function handleFamilySetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return

    const familyName = setupFamilyName.trim()
    const displayName = setupDisplayName.trim()

    if (!familyName || !displayName) return

    const managedMembers = setupManagedMembers
      .split(/[,\n]/)
      .map((name) => name.trim())
      .filter(Boolean)

    setSetupBusy(true)
    setSetupError(null)
    setSetupMessage(null)

    const { data, error } = await supabase.functions.invoke('core', {
      body: {
        action: 'bootstrap',
        family_name: familyName,
        display_name: displayName,
        managed_members: managedMembers,
        second_owner_email: setupSecondOwnerEmail.trim() || null,
        redirect_to: window.location.origin,
        device_locale: appLocale,
        device_timezone: deviceTimezone,
      },
    })

    setSetupBusy(false)

    if (error) {
      setSetupError(error.message)
      return
    }

    if (data?.status === 'created' || data?.status === 'exists') {
      if (data?.second_owner_invitation_warning) {
        setSetupMessage(
          `A család elkészült, de a másik családi felhasználó meghívása nem sikerült: ${data.second_owner_invitation_warning}`,
        )
      } else {
        setSetupMessage('A család elkészült.')
      }

      setFamilyRefreshKey((value) => value + 1)
      return
    }

    setSetupError(data?.error ?? 'A családot most nem sikerült létrehozni.')
  }

  async function handleAddFamilyMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return

    const displayName = newFamilyMemberName.trim()
    if (!displayName) return

    setFamilyActionBusy(true)
    setFamilyActionError(null)
    setFamilyActionMessage(null)

    const { data, error } = await supabase.functions.invoke('core', {
      body: {
        action: 'add_managed_member',
        display_name: displayName,
      },
    })

    setFamilyActionBusy(false)

    if (error || data?.error) {
      setFamilyActionError(error?.message ?? data?.error ?? 'A családtagot most nem sikerült hozzáadni.')
      return
    }

    setNewFamilyMemberName('')
    setFamilyActionMessage(`${displayName} hozzáadva a családhoz.`)
    setFamilyRefreshKey((value) => value + 1)
  }

  async function handleInviteSecondOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return

    const email = secondOwnerInviteEmail.trim()
    if (!email) return

    setFamilyActionBusy(true)
    setFamilyActionError(null)
    setFamilyActionMessage(null)

    const { data, error } = await supabase.functions.invoke('core', {
      body: {
        action: 'invite_second_owner',
        email,
        redirect_to: window.location.origin,
        ui_locale: appLocale,
      },
    })

    setFamilyActionBusy(false)

    if (error || data?.error) {
      setFamilyActionError(error?.message ?? data?.error ?? 'A meghívót most nem sikerült elküldeni.')
      return
    }

    setSecondOwnerInviteEmail('')
    setFamilyActionMessage('Meghívó elküldve a másik családi felhasználónak.')
  }

  async function handleAcceptOwnerInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return

    const displayName = invitationDisplayName.trim()
    if (!displayName || invitationPassword.length < 6) return

    setInvitationBusy(true)
    setInvitationError(null)

    const { error: passwordError } = await supabase.auth.updateUser({
      password: invitationPassword,
      data: { ui_locale: appLocale },
    })

    if (passwordError) {
      setInvitationBusy(false)
      setInvitationError(authErrorText(appLocale, passwordError.message))
      return
    }

    const { data, error } = await supabase.functions.invoke('core', {
      body: {
        action: 'accept_owner_invitation',
        display_name: displayName,
        device_locale: appLocale,
        device_timezone: deviceTimezone,
      },
    })

    setInvitationBusy(false)

    if (error || data?.error) {
      setInvitationError(error?.message ?? data?.error ?? 'A családhoz csatlakozás most nem sikerült.')
      return
    }

    setPendingOwnerInvitation(false)
    setInvitationFamilyName(null)
    setInvitationDisplayName('')
    setInvitationPassword('')
    setFamilyRefreshKey((value) => value + 1)
  }

  // Csak felhasználónak megjelenítendő szöveget fordítunk dánra.
  async function invokeLocalizedCore(options: { body: Record<string, unknown> }) {
    if (!supabase) throw new Error('Nincs aktív kapcsolat.')
    const result = await supabase.functions.invoke('core', {
      ...options,
      body: { ...options.body, ui_locale: appLocale },
    })
    if (result.error || !result.data) return result
    const data = result.data as Record<string, any>
    const strings: string[] = []
    const setters: Array<(value: string) => void> = []
    const add = (obj: Record<string, any> | null | undefined, field: string) => {
      if (obj && typeof obj[field] === 'string' && obj[field].trim()) {
        strings.push(obj[field])
        setters.push((value) => { obj[field] = value })
      }
    }
    if (appLocale === 'da-DK') {
      for (const field of ['answer','summary','question','message','error','prompt',
        'assignment_notification_warning','partner_notification_warning']) add(data, field)
    }
    add(data.draft, 'confirmation_text')
    if (Array.isArray(data.candidates)) {
      for (const candidate of data.candidates.slice(0, 25)) add(candidate, 'label')
    }
    if (Array.isArray(data.items)) {
      for (const item of data.items.slice(0, 25)) add(item, 'label')
    }

    // Fordítási hiba esetén az eredeti szerverválasz megmarad.
    for (let offset = 0; offset < strings.length; offset += 10) {
      try {
        const chunk = strings.slice(offset, offset + 10)
        const translated = await supabase.functions.invoke('core', {
          body: { action: 'localize_display_text', texts: chunk, ui_locale: appLocale },
        })
        if (translated.error || !Array.isArray(translated.data?.translations)
          || translated.data.translations.length !== chunk.length) continue
        translated.data.translations.forEach((value: unknown, index: number) => {
          if (typeof value === 'string' && value.trim()) setters[offset + index](value)
        })
      } catch { /* az eredeti szöveg marad */ }
    }
    return result
  }

  async function transcribeVoiceRecording(audio: Blob, mimeType: string) {
    if (!supabase || !session) return

    setVoiceTranscribing(true)
    setVoiceError(null)

    try {
      const extension = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm'
      const form = new FormData()
      form.append('file', new File([audio], `penzfa-voice.${extension}`, { type: mimeType }))
      form.append('language', appLocale === 'da-DK' ? 'da' : 'hu')
      form.append(
        'member_names',
        familyMembers.map((member) => member.display_name).join(', '),
      )

      const invokeTranscription = () => supabase.functions.invoke('transcribe-audio', {
        body: form,
      })

      let { data, error } = await invokeTranscription()

      if (error) {
        const response = (error as { context?: unknown }).context
        const status = response instanceof Response ? response.status : null

        if (status === 401) {
          await supabase.auth.refreshSession()
          ;({ data, error } = await invokeTranscription())
        } else if (status === 429 || (status !== null && status >= 500)) {
          await new Promise((resolve) => window.setTimeout(resolve, 400))
          ;({ data, error } = await invokeTranscription())
        }
      }

      if (error || !data?.text) {
        let detail = data?.error
        const response = (error as { context?: unknown } | null)?.context
        if (!detail && response instanceof Response) {
          try {
            const payload = await response.clone().json()
            detail = payload?.error
          } catch {
            // A Supabase kliens általános hibaüzenetét használjuk.
          }
        }
        setVoiceError(detail ?? error?.message ?? 'A hang átírása nem sikerült.')
        return
      }

      setCreateMessage(String(data.text).trim())
      const addingReminderToDraft = Boolean(
        createDraft?.due_date && !createDraft.first_reminder_at,
      )
      if (!addingReminderToDraft && !reminderEditTarget) setCreateDraft(null)
      setCompleteDraft(null)
      setUpdateDraft(null)
      setReminderUpdateDraft(null)
      setDeleteDraft(null)
      setCreateError(null)
      setCreateSuccess(null)
      if (!reminderEditTarget) setAssistantAnswer(null)
      setQueryResults([])
    } catch (error) {
      setVoiceError(
        error instanceof Error
          ? error.message
          : 'A hang átírása most nem sikerült.',
      )
    } finally {
      setVoiceTranscribing(false)
    }
  }

  async function handleVoiceInput() {
    if (createBusy || voiceTranscribing) return

    const activeRecorder = mediaRecorderRef.current
    if (voiceListening && activeRecorder && activeRecorder.state !== 'inactive') {
      activeRecorder.stop()
      return
    }

    if (
      !navigator.mediaDevices?.getUserMedia
      || typeof MediaRecorder === 'undefined'
    ) {
      setVoiceError('Ez az eszköz nem támogatja a közvetlen hangfelvételt.')
      return
    }

    try {
      setVoiceError(null)
      setCreateMessage('')
      const addingReminderToDraft = Boolean(
        createDraft?.due_date && !createDraft.first_reminder_at,
      )
      if (!addingReminderToDraft && !reminderEditTarget) setCreateDraft(null)
      setCompleteDraft(null)
      setUpdateDraft(null)
      setReminderUpdateDraft(null)
      setDeleteDraft(null)
      setCreateError(null)
      setCreateSuccess(null)
      if (!reminderEditTarget) setAssistantAnswer(null)
      setQueryResults([])

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream

      const preferredTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
      ]
      const supportedType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = supportedType
        ? new MediaRecorder(stream, { mimeType: supportedType })
        : new MediaRecorder(stream)

      mediaRecorderRef.current = recorder
      audioChunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data)
      }

      recorder.onerror = () => {
        setVoiceListening(false)
        setVoiceError('A hangfelvétel megszakadt. Próbáld újra.')
        stream.getTracks().forEach((track) => track.stop())
        mediaRecorderRef.current = null
        mediaStreamRef.current = null
      }

      recorder.onstop = () => {
        const mimeType = recorder.mimeType || supportedType || 'audio/webm'
        const audio = new Blob(audioChunksRef.current, { type: mimeType })

        stream.getTracks().forEach((track) => track.stop())
        mediaRecorderRef.current = null
        mediaStreamRef.current = null
        audioChunksRef.current = []
        setVoiceListening(false)

        if (audio.size > 0) {
          void transcribeVoiceRecording(audio, mimeType)
        }
      }

      // Rövid szeletekben gyűjtjük a hangot. Android/PWA alatt ez
      // stabilabb az első felvételnél, mint egyetlen záró Blob-ra hagyatkozni.
      recorder.start(250)
      setVoiceListening(true)
    } catch (error) {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
      mediaRecorderRef.current = null
      mediaStreamRef.current = null
      setVoiceListening(false)
      setVoiceError(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'A mikrofon nincs engedélyezve. Engedélyezd az AI családi asszisztensnek a mikrofon használatát.'
          : 'A mikrofont most nem sikerült elindítani.',
      )
    }
  }

  async function handleMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return

    const message = createMessage.trim()
    if (!message) return


    if (dateEditTarget) {
      setCreateBusy(true)
      setCreateError(null)
      setCreateSuccess(null)
      setVoiceError(null)

      const { data: parsed, error: parseError } = await invokeLocalizedCore({
        body: {
          action: 'interpret_selected_item_change',
          target_item_id: dateEditTarget.id,
          message,
        },
      })

      if (parseError || parsed?.status !== 'ok' || !parsed?.changes) {
        setCreateBusy(false)
        setCreateError(parseError?.message ?? parsed?.error ?? 'Az új időpont nem egyértelmű.')
        return
      }

      const { data, error } = await invokeLocalizedCore({
        body: {
          action: 'prepare_update_target',
          target_item_id: dateEditTarget.id,
          changes: parsed.changes,
        },
      })

      setCreateBusy(false)
      if (error || data?.status !== 'needs_confirmation' || !data?.draft) {
        setCreateError(error?.message ?? data?.error ?? 'A módosítást nem sikerült előkészíteni.')
        return
      }

      setCreateMessage('')
      setUpdateDraft(data.draft as UpdateDraft)
      setCreateError(null)
      return
    }

    if (reminderEditTarget) {
      setCreateBusy(true)
      setCreateError(null)
      setCreateSuccess(null)
      setVoiceError(null)

      const { data, error } = await invokeLocalizedCore({
        body: {
          action: 'prepare_reminder_update',
          target_item_id: reminderEditTarget.id,
          reminder_phrase: message,
        },
      })

      setCreateBusy(false)
      setCreateMessage('')

      if (error) {
        setCreateError(error.message)
        return
      }

      if (data?.status === 'needs_confirmation' && data?.draft) {
        setReminderUpdateDraft(data.draft as UpdateDraft)
        setAssistantAnswer(null)
        setCreateError(null)
        return
      }

      if (data?.status === 'reminder_needs_clarification') {
        setCreateError(data.error ?? 'Az emlékeztetés időpontját még pontosítani kell.')
        return
      }

      setCreateError(data?.error ?? 'Az emlékeztetést most nem sikerült módosítani.')
      return
    }

    if (createDraft?.due_date && !createDraft.first_reminder_at) {
      setCreateBusy(true)
      setCreateError(null)
      setCreateSuccess(null)
      setVoiceError(null)

      const { data, error } = await invokeLocalizedCore({
        body: {
          action: 'add_create_reminder',
          draft: createDraft,
          reminder_phrase: message,
        },
      })

      setCreateBusy(false)
      setCreateMessage('')

      if (error) {
        setCreateError(error.message)
        return
      }

      if (data?.status === 'no_reminder') {
        await confirmCreateDraft(createDraft, 'none')
        return
      }

      if (data?.status === 'needs_confirmation' && data?.draft) {
        setCreateDraft(data.draft as CreateDraft)
        setCreateError(null)
        return
      }

      if (data?.status === 'reminder_needs_clarification' && data?.draft) {
        setCreateDraft(data.draft as CreateDraft)
        setCreateError(data.error ?? 'Az emlékeztetés időpontját még pontosítani kell.')
        return
      }

      setCreateError(data?.error ?? 'Az emlékeztetés időpontját nem sikerült értelmezni.')
      return
    }

    setCreateBusy(true)
    setCreateDraft(null)
    setCompleteDraft(null)
    setCompleteCandidates([])
    setUpdateDraft(null)
    setReminderUpdateDraft(null)
    setReminderEditTarget(null)
    setDateEditTarget(null)
    setReminderFollowUp(null)
    setDeleteDraft(null)
    setCreateError(null)
    setCreateSuccess(null)
    setAssistantAnswer(null)
    setQueryResults([])
    setVoiceError(null)

    const { data: intentData, error: intentError } = await invokeLocalizedCore({
      body: {
        action: 'interpret_intent',
        message,
      },
    })

    if (intentError) {
      setCreateBusy(false)
      setCreateError(intentError.message)
      return
    }

    if (intentData?.status === 'needs_clarification') {
      setCreateBusy(false)
      setAssistantAnswer(
        intentData.question ?? 'Pontosítsd kérlek, mit szeretnél.',
      )
      setCreateMessage('')
      return
    }

    if (intentData?.intent === 'query') {
      const { data, error } = await invokeLocalizedCore({
        body: {
          action: 'query_items',
          message,
        },
      })

      setCreateBusy(false)

      if (error) {
        setCreateError(error.message)
        return
      }

      const structuredItems = Array.isArray(data?.items)
        ? data.items as QueryResultItem[]
        : []

      setQueryResults(structuredItems)
      setAssistantAnswer(
        data?.status === 'choose_target'
          ? data?.answer ?? 'Több lehetséges ügyet találtam. Pontosítsd, melyikre gondolsz.'
          : structuredItems.length
            ? data?.summary ?? null
            : data?.answer ?? data?.error ?? 'Nem találtam választ a kérdésre.',
      )
      setCreateMessage('')
      return
    }

    if (intentData?.intent === 'complete') {
      const { data, error } = await invokeLocalizedCore({
        body: {
          action: 'interpret_complete',
          message,
        },
      })

      setCreateBusy(false)

      if (error) {
        setCreateError(error.message)
        return
      }

      if (data?.status === 'needs_confirmation' && data?.draft) {
        setCompleteDraft(data.draft as CompleteDraft)
        setCreateMessage('')
        return
      }

      if (data?.status === 'choose_target') {
        const candidates = Array.isArray(data.candidates)
          ? data.candidates as CompleteCandidate[]
          : []

        setCompleteCandidates(candidates)
        setAssistantAnswer(
          candidates.length
            ? null
            : 'Több egyező nyitott ügyet találtam. Kérlek, pontosíts.',
        )
        setCreateMessage('')
        return
      }

      if (data?.status === 'future_event_needs_date') {
        setAssistantAnswer(
          data.prompt ?? 'Ez az esemény még jövőbeli. Írd meg, mikor történt meg valójában.',
        )
        setCreateMessage('')
        return
      }

      setAssistantAnswer(
        data?.error ?? 'Nem találtam egyértelműen ilyen nyitott ügyet.',
      )
      return
    }

    if (intentData?.intent === 'update') {
      const { data, error } = await invokeLocalizedCore({
        body: {
          action: 'interpret_update',
          message,
        },
      })

      setCreateBusy(false)

      if (error) {
        setCreateError(error.message)
        return
      }

      if (data?.status === 'needs_confirmation' && data?.draft) {
        setUpdateDraft(data.draft as UpdateDraft)
        setCreateMessage('')
        return
      }

      if (data?.status === 'choose_target') {
        const labels = (data.candidates ?? [])
          .map((candidate: { label?: string }) => candidate.label)
          .filter(Boolean)
          .join('\n• ')

        setAssistantAnswer(
          labels
            ? `Több egyező nyitott ügyet találtam. Pontosítsd, melyikre gondolsz:\n• ${labels}`
            : 'Több egyező nyitott ügyet találtam. Kérlek, pontosíts.',
        )
        return
      }

      if (data?.status === 'needs_change_details') {
        setAssistantAnswer(
          data.error ?? 'Megtaláltam az ügyet. Mondd meg, mire szeretnéd módosítani.',
        )
        setCreateMessage('')
        return
      }

      setAssistantAnswer(
        data?.error ?? 'Nem találtam egyértelműen a módosítandó ügyet.',
      )
      return
    }

    if (intentData?.intent === 'delete') {
      const { data, error } = await invokeLocalizedCore({
        body: {
          action: 'interpret_delete',
          message,
        },
      })

      setCreateBusy(false)

      if (error) {
        setCreateError(error.message)
        return
      }

      if (data?.status === 'needs_confirmation' && data?.draft) {
        setDeleteDraft(data.draft as DeleteDraft)
        setCreateMessage('')
        return
      }

      if (data?.status === 'choose_target') {
        const labels = (data.candidates ?? [])
          .map((candidate: { label?: string }) => candidate.label)
          .filter(Boolean)
          .join('\n• ')

        setAssistantAnswer(
          labels
            ? `Több egyező nyitott ügyet találtam. Pontosítsd, melyiket töröljem:\n• ${labels}`
            : 'Több egyező nyitott ügyet találtam. Kérlek, pontosíts.',
        )
        setCreateMessage('')
        return
      }

      setAssistantAnswer(
        data?.error ?? 'Nem találtam egyértelműen a törlendő ügyet.',
      )
      return
    }

    if (intentData?.intent !== 'create') {
      setCreateBusy(false)
      setAssistantAnswer(
        'Ezt a műveletet a következő lépésben kötjük be a beszélgetéses felületre.',
      )
      return
    }

    const { data, error } = await invokeLocalizedCore({
      body: {
        action: 'interpret_create',
        message,
      },
    })

    setCreateBusy(false)

    if (error) {
      setCreateError(error.message)
      return
    }

    if (data?.status === 'needs_confirmation' && data?.draft) {
      setCreateDraft(data.draft as CreateDraft)
      setCreateMessage('')
      return
    }

    if (data?.status === 'reminder_needs_clarification' && data?.draft) {
      setCreateDraft(data.draft as CreateDraft)
      setCreateError(data.error ?? 'Az emlékeztetés időpontját még pontosítani kell.')
      setCreateMessage('')
      return
    }

    if (data?.status === 'duplicate') {
      setCreateError(data.message ?? 'Ez az ügy már szerepel a nyitott ügyek között.')
      setCreateMessage('')
      return
    }

    setCreateError(data?.error ?? 'Az ügyet most nem sikerült értelmezni.')
  }

  async function handleConfirmDelete() {
    if (!supabase || !deleteDraft) return

    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)
    setAssistantAnswer(null)

    const { data, error } = await invokeLocalizedCore({
      body: {
        action: 'confirm_delete',
        pending_action_id: deleteDraft.pending_action_id,
      },
    })

    setCreateBusy(false)

    if (error) {
      setCreateError(error.message)
      return
    }

    if (data?.status === 'deleted') {
      setCreateSuccess(`${appLocale === 'da-DK' ? 'Slettet' : 'Törölve'}: ${data.item?.title ?? (appLocale === 'da-DK' ? 'opgave' : 'ügy')}`)
      setCreateMessage('')
      setDeleteDraft(null)
      return
    }

    setCreateError(data?.error ?? 'Az ügyet most nem sikerült törölni.')
  }

  function startReminderEdit(itemId: string, title: string) {
    setReminderFollowUp(null)
    setDateEditTarget(null)
    setReminderEditTarget({ id: itemId, title })
    setReminderUpdateDraft(null)
    setCreateMessage('')
    setCreateDraft(null)
    setCompleteDraft(null)
    setCompleteCandidates([])
    setUpdateDraft(null)
    setDeleteDraft(null)
    setCreateError(null)
    setCreateSuccess(null)
    setQueryResults([])
    setAssistantAnswer(
      appLocale === 'da-DK'
        ? `Rediger påmindelsen for ${title}. Skriv eller indtal det nye tidspunkt, for eksempel "en halv time før", "samme dag kl. 18" eller "ingen påmindelse".`
        : `Emlékeztető módosítása: ${title}. Írd vagy mondd be az új időpontot, például: „előtte fél órával”, „aznap 18-kor”, vagy „nem kérek emlékeztetőt”.`,
    )
  }


  function startDateEdit(itemId: string, title: string) {
    setReminderFollowUp(null)
    setDateEditTarget({ id: itemId, title })
    setReminderEditTarget(null)
    setReminderUpdateDraft(null)
    setCreateMessage('')
    setCreateDraft(null)
    setCompleteDraft(null)
    setCompleteCandidates([])
    setUpdateDraft(null)
    setDeleteDraft(null)
    setCreateError(null)
    setCreateSuccess(null)
    setQueryResults([])
    setAssistantAnswer(
      `Dátum/időpont módosítása: ${title}. Írd vagy mondd be az új dátumot vagy időpontot, például: „jövő kedden 14:30-kor” vagy „aznap 16:00-kor”.`,
    )
  }

  async function handleConfirmReminderUpdate() {
    if (!supabase || !reminderUpdateDraft) return

    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)

    const { data, error } = await invokeLocalizedCore({
      body: {
        action: 'confirm_reminder_update',
        pending_action_id: reminderUpdateDraft.pending_action_id,
      },
    })

    setCreateBusy(false)

    if (error) {
      setCreateError(error.message)
      return
    }

    if (data?.status === 'reminder_updated') {
      setCreateSuccess(`${appLocale === 'da-DK' ? 'Påmindelse ændret' : 'Emlékeztető módosítva'}: ${data.item?.title ?? reminderEditTarget?.title ?? (appLocale === 'da-DK' ? 'opgave' : 'ügy')}`)
      setReminderUpdateDraft(null)
      setReminderEditTarget(null)
      setAssistantAnswer(null)
      return
    }

    setCreateError(data?.error ?? 'Az emlékeztetőt most nem sikerült módosítani.')
  }

  async function handleDisableReminderFromFollowUp() {
    if (!supabase || !reminderFollowUp) return

    setCreateBusy(true)
    setCreateError(null)
    const target = reminderFollowUp
    const { data, error } = await invokeLocalizedCore({
      body: {
        action: 'prepare_reminder_update',
        target_item_id: target.id,
        reminder_phrase: 'nem kérek emlékeztetőt',
      },
    })
    setCreateBusy(false)

    if (error || data?.status !== 'needs_confirmation' || !data?.draft) {
      setCreateError(error?.message ?? data?.error ?? 'Az emlékeztető kikapcsolását nem sikerült előkészíteni.')
      return
    }

    setReminderFollowUp(null)
    setReminderEditTarget(target)
    setReminderUpdateDraft(data.draft as UpdateDraft)
    setCreateSuccess(null)
  }

  async function handleConfirmUpdate() {
    if (!supabase || !updateDraft) return

    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)
    setAssistantAnswer(null)

    const { data, error } = await invokeLocalizedCore({
      body: {
        action: 'confirm_update',
        pending_action_id: updateDraft.pending_action_id,
      },
    })

    setCreateBusy(false)

    if (error) {
      setCreateError(error.message)
      return
    }

    if (data?.status === 'updated') {
      setCreateSuccess(`${appLocale === 'da-DK' ? 'Ændret' : 'Módosítva'}: ${data.item?.title ?? (appLocale === 'da-DK' ? 'opgave' : 'ügy')}`)
      setCreateMessage('')
      setUpdateDraft(null)
      setDateEditTarget(null)
      const review = data.reminder_review as { reminder_at: string | null } | null
      if (review && data.item?.id) {
        setReminderFollowUp({
          id: String(data.item.id),
          title: String(data.item.title),
          reminder_at: review.reminder_at,
        })
      } else {
        setReminderFollowUp(null)
      }
      return
    }

    setCreateError(data?.error ?? 'Az ügyet most nem sikerült módosítani.')
  }

  async function handleCompleteCandidate(candidate: Pick<CompleteCandidate, 'id' | 'title'>) {
    if (!supabase) return

    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)

    const { data: prepared, error: prepareError } = await invokeLocalizedCore({
      body: {
        action: 'prepare_complete_target',
        target_item_id: candidate.id,
      },
    })

    if (prepareError) {
      setCreateBusy(false)
      setCreateError(prepareError.message)
      return
    }

    if (prepared?.status === 'future_event_needs_date') {
      setCreateBusy(false)
      setAssistantAnswer(
        prepared.prompt ?? 'Ez az esemény még jövőbeli. Írd meg, mikor történt meg valójában.',
      )
      return
    }

    if (prepared?.status !== 'needs_confirmation' || !prepared?.draft?.pending_action_id) {
      setCreateBusy(false)
      setCreateError(prepared?.error ?? 'A kiválasztott ügyet most nem sikerült előkészíteni.')
      return
    }

    const { data, error } = await invokeLocalizedCore({
      body: {
        action: 'confirm_complete',
        pending_action_id: prepared.draft.pending_action_id,
      },
    })

    setCreateBusy(false)

    if (error) {
      setCreateError(error.message)
      return
    }

    if (data?.status === 'completed') {
      setCreateSuccess(`${appLocale === 'da-DK' ? 'Markeret som udført' : 'Készre jelölve'}: ${data.item?.title ?? candidate.title}`)
      setCompleteCandidates([])
      setQueryResults((current) => current.filter((item) => item.id !== candidate.id))
      setAssistantAnswer(data.partner_notification_warning ?? null)
      return
    }

    setCreateError(data?.error ?? 'Az ügyet most nem sikerült készre jelölni.')
  }

  async function handleConfirmComplete() {
    if (!supabase || !completeDraft) return

    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)
    setAssistantAnswer(null)

    const { data, error } = await invokeLocalizedCore({
      body: {
        action: 'confirm_complete',
        pending_action_id: completeDraft.pending_action_id,
      },
    })

    setCreateBusy(false)

    if (error) {
      setCreateError(error.message)
      return
    }

    if (data?.status === 'completed') {
      setCreateSuccess(`${appLocale === 'da-DK' ? 'Markeret som udført' : 'Készre jelölve'}: ${data.item?.title ?? (appLocale === 'da-DK' ? 'opgave' : 'ügy')}`)
      setCreateMessage('')
      setCompleteDraft(null)
      setCompleteCandidates([])

      if (data.partner_notification_warning) {
        setAssistantAnswer(data.partner_notification_warning)
      }
      return
    }

    setCreateError(data?.error ?? 'Az ügyet most nem sikerült készre jelölni.')
  }

  async function confirmCreateDraft(
    draft: CreateDraft,
    reminderDecision: 'scheduled' | 'none',
  ) {
    if (!supabase) return

    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)

    const { data, error } = await invokeLocalizedCore({
      body: {
        action: 'confirm_create',
        draft,
        reminder_decision: reminderDecision,
      },
    })

    setCreateBusy(false)

    if (error) {
      setCreateError(error.message)
      return
    }

    if (data?.status === 'created') {
      setCreateSuccess(`${appLocale === 'da-DK' ? 'Gemt' : 'Rögzítve'}: ${data.item?.title ?? draft.title}`)
      setCreateMessage('')
      setCreateDraft(null)

      if (data.assignment_notification_warning) {
        setAssistantAnswer(data.assignment_notification_warning)
      }
      return
    }

    if (data?.status === 'duplicate') {
      setCreateError(data.message ?? 'Ez az ügy már szerepel a nyitott ügyek között.')
      setCreateDraft(null)
      return
    }

    setCreateError(data?.error ?? 'Az ügyet most nem sikerült rögzíteni.')
  }

  async function handleConfirmCreate() {
    if (!createDraft) return
    await confirmCreateDraft(
      createDraft,
      createDraft.first_reminder_at ? 'scheduled' : 'none',
    )
  }

  function handleCancelCreate() {
    setCreateDraft(null)
    setCompleteDraft(null)
    setCompleteCandidates([])
    setUpdateDraft(null)
    setReminderUpdateDraft(null)
    setReminderEditTarget(null)
    setDateEditTarget(null)
    setReminderFollowUp(null)
    setDeleteDraft(null)
    setCreateError(null)
    setCreateSuccess(null)
    setAssistantAnswer(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return

    setSubmitting(true)
    setMessage(null)
    setErrorMessage(null)

    const result =
      mode === 'sign-in'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
            options: {
              emailRedirectTo: `${window.location.origin}/?email_confirmed=1`,
              data: {
                ui_locale: appLocale,
              },
            },
          })

    setSubmitting(false)

    if (result.error) {
      setErrorMessage(authErrorText(appLocale, result.error.message))
      return
    }

    if (mode === 'sign-up' && !result.data.session) {
      const identities = result.data.user?.identities ?? []

      if (identities.length === 0) {
        setMode('sign-in')
        setConfirmationEmail(null)
        setResendMessage(null)
        setErrorMessage(
          tr('Ezzel az e-mail-címmel már regisztráltak. Lépj be a fiókodba.'),
        )
        return
      }

      setConfirmationEmail(email)
      setResendCooldown(60)
      setResendMessage(null)
      setPassword('')
      return
    }

    setMessage(null)
    setErrorMessage(null)
    setEmail('')
    setPassword('')
  }

  async function handleResendConfirmation() {
    if (!supabase || !confirmationEmail || resendCooldown > 0) return

    setResendBusy(true)
    setResendMessage(null)
    setErrorMessage(null)

    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: confirmationEmail,
      options: {
        emailRedirectTo: `${window.location.origin}/?email_confirmed=1`,
      },
    })

    setResendBusy(false)

    if (error) {
      setErrorMessage(authErrorText(appLocale, error.message))
      return
    }

    setResendCooldown(60)
    setResendMessage(
      tr('Új megerősítő e-mailt küldtünk. Ha több levelet kaptál, mindig a legfrissebb levél linkjét használd.'),
    )
  }

  async function handleInstallApp() {
    if (!installPrompt) return

    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }

  async function handleSignOut() {
    if (!supabase) return

    setErrorMessage(null)

    if (pushAppId) {
      try {
        const oneSignal = await getOneSignalClient(pushAppId)
        await oneSignal.logout()
      } catch {
        // A kijelentkezést a push leválasztási hiba nem blokkolhatja.
      }
    }

    const { error } = await supabase.auth.signOut({ scope: 'local' })

    if (error) {
      setErrorMessage(error.message)
      return
    }

    setShowHelp(false)
    setMode('sign-in')
    setEmail('')
    setPassword('')
    setMessage(null)
    setErrorMessage(null)
  }

  if (!hasSupabaseConfig) {
    return (
      <main className="shell">
        <section className="card">
          <p className="eyebrow">{tr("AI családi asszisztens")}</p>
          <h1>{tr("Beállítás szükséges")}</h1>
          <p className="lead">
            {tr("A Cloudflare deployból hiányzik a Supabase projekt URL-je vagy publishable key-je.")}
          </p>
          <p className="notice error">
            {tr("Add hozzá a VITE_SUPABASE_URL és VITE_SUPABASE_PUBLISHABLE_KEY környezeti változókat, majd indíts új deployt.")}
          </p>
        </section>
      </main>
    )
  }

  if (loadingSession) {
    return (
      <main className="shell">
        <section className="card">
          <p className="eyebrow">{tr("AI családi asszisztens")}</p>
          <p>{tr("Belépés ellenőrzése…")}</p>
        </section>
      </main>
    )
  }

  if (session) {
    const activeUserMember = familyMembers.find((member) => member.user_id === session.user.id) ?? null
    const greeting = greetingForHour(new Date().getHours(), appLocale)
    const currentPushCopy = localizedPush?.source === pushContext?.message
      && localizedPush?.locale === appLocale ? localizedPush : null
    const exampleManagedMember = familyMembers.find((member) => member.member_kind === 'managed') ?? null
    const exampleText = exampleManagedMember
      ? `${exampleManagedMember.display_name} kontrollja jövő kedden 10-kor.`
      : 'Jövő kedden 10-kor kontroll.'

    if (showHelp) {
      if (appLocale === 'da-DK') {
        return <DanishHelp onBack={() => {
          setShowHelp(false)
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }} />
      }
      return (
        <main className="shell">
          <section className="card help-page">
            <button
              className="help-back-button"
              type="button"
              onClick={() => {
                setShowHelp(false)
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }}
            >
              {tr("← Vissza")}
            </button>

            <header className="app-header help-header">
              <p className="eyebrow">{tr("AI családi asszisztens")}</p>
              <h1>Súgó</h1>
              <p className="lead">
                {tr("Írd vagy mondd természetesen, mit szeretnél. Nem kell parancsokat megtanulnod.")}
              </p>
            </header>

            <div className="help-sections">
              <details className="help-section" open>
                <summary>Mi az AI családi asszisztens?</summary>
                <p>
                  Az AI családi asszisztens abban segít, hogy ne kelljen fejben tartanod
                  a család mindennapi teendőit, időpontjait és határidőit.
                  Természetes nyelven elmondhatod vagy leírhatod, mit kell elintézni.
                </p>
                <p>
                  A rendszer értelmezi a kérésedet, strukturáltan eltárolja a fontos adatokat,
                  emlékeztethet rá, reggeli összefoglalót készíthet, és később vissza is keresheted.
                </p>
                <div className="help-examples">
                  <strong>Alapfogalmak</strong>
                  <ul>
                    <li>
                      <strong>Családi felhasználó:</strong> saját fiókkal rendelkezik, be tud lépni,
                      használhatja az alkalmazást, feladatokat kezelhet és értesítéseket kaphat.
                    </li>
                    <li>
                      <strong>Kezelt családtag:</strong> nincs saját belépése, de a hozzá kapcsolódó
                      feladatokat és eseményeket a családi felhasználók kezelhetik.
                    </li>
                    <li>
                      Egy családhoz jelenleg legfeljebb két családi felhasználó tartozhat,
                      kezelt családtagból pedig több is felvehető.
                    </li>
                  </ul>
                </div>
              </details>

              <details className="help-section">
                <summary>Feladat vagy esemény rögzítése</summary>
                <p>
                  Mondd el, mi a teendő, kire vonatkozik és mikorra kell.
                  A rendszer rögzítés előtt visszakérdez és megerősítést kér.
                </p>
                <div className="help-examples">
                  <strong>Példák</strong>
                  <ul>
                    <li>„Holnap 10-kor hívjam fel a könyvelőt.”</li>
                    <li>„Bence kontrollja jövő kedden 10-kor.”</li>
                    <li>„Anya pénteken hívja fel a szerelőt.”</li>
                  </ul>
                </div>
              </details>

              <details className="help-section">
                <summary>Emlékeztetők</summary>
                <p>
                  Az emlékeztetőt megadhatod már a rögzítéskor, vagy később is.
                  Ha másik családi felhasználó a felelős, a saját emlékeztetőjét ő kapja.
                </p>
                <div className="help-examples">
                  <strong>Példák</strong>
                  <ul>
                    <li>„Szólj egy órával előtte.”</li>
                    <li>„Másfél órával előtte.”</li>
                    <li>„Emlékeztess hétfőn 18:00-kor.”</li>
                  </ul>
                </div>
              </details>

              <details className="help-section">
                <summary>Keresés és lekérdezés</summary>
                <p>
                  Kérdezhetsz a saját vagy a család nyitott és korábbi feladatairól.
                  Családtag, felelős és időszak szerint is szűrhetsz.
                </p>
                <div className="help-examples">
                  <strong>Példák</strong>
                  <ul>
                    <li>„Mik a nyitott feladataim?”</li>
                    <li>„Milyen feladataim vannak Bencével ezen a héten?”</li>
                    <li>„Melyik feladathoz nincs emlékeztető?”</li>
                  </ul>
                </div>
              </details>

              <details className="help-section">
                <summary>Módosítás</summary>
                <p>
                  Meglévő feladat dátuma, időpontja és emlékeztetője módosítható.
                  Ha több találat van, előbb válaszd ki a megfelelő feladatot.
                </p>
                <div className="help-examples">
                  <strong>Példák</strong>
                  <ul>
                    <li>„A fogorvost tedd át péntekre.”</li>
                    <li>„Ennek az emlékeztetőjét tedd holnap 8-ra.”</li>
                  </ul>
                </div>
              </details>

              <details className="help-section">
                <summary>Készre jelölés és törlés</summary>
                <p>
                  Készre jelölésnél és törlésnél a rendszer azonosítja a feladatot,
                  és bizonytalan vagy végleges művelet előtt megerősítést kér.
                </p>
                <div className="help-examples">
                  <strong>Példák</strong>
                  <ul>
                    <li>„A könyvelőt elintéztem.”</li>
                    <li>„Töröld a pénteki fodrászt.”</li>
                  </ul>
                </div>
              </details>

              <details className="help-section">
                <summary>Családi felhasználók és kezelt családtagok</summary>
                <p>
                  A Családtagok résznél név szerint felvehetsz kezelt családtagokat.
                  Egy másik családi felhasználót e-mailben meghívhatsz, így ketten használhatjátok ugyanazt a családot.
                </p>
                <p>
                  Ha a másik családi felhasználónak adsz feladatot, értesítést kap róla, ha nála az értesítések engedélyezve vannak.
                </p>
              </details>

              <details className="help-section">
                <summary>Értesítések, reggeli briefing és telepítés</summary>
                <p>
                  Az értesítéseket eszközönként kell engedélyezni a Fiók és értesítések részben.
                  A reggeli briefing időpontja a Beállítások alatt módosítható.
                </p>
                <p>
                  Ha még böngészőből használod az alkalmazást, a Telepítés a telefonra résznél
                  kiteheted a kezdőképernyőre.
                </p>
              </details>
            </div>
          </section>
        </main>
      )
    }

    return (
      <main className="shell">
        <section className="card">
          <header className="app-header">
            <h1>{familyName ?? tr("Kezdjük a beállítást")}</h1>
            <p className="lead">
              {familyLoading
                ? tr("Család betöltése…")
                : familyName
                  ? activeUserMember
                    ? `${greeting}, ${activeUserMember.display_name}!`
                    : `${greeting}!`
                  : tr("Két adat kell az induláshoz.")}
            </p>
          </header>

          {familyError && <p className="notice error">{familyError}</p>}

          {emailJustConfirmed && !familyLoading && !familyName && !familyError && (
            <p className="notice success">
              {tr("E-mail-cím megerősítve.")}
            </p>
          )}

          {!familyLoading && !familyName && !familyError && pendingOwnerInvitation && (
            <section className="setup-block" aria-label={tr("Csatlakozás a családhoz")}>
              <h2>{tr("Csatlakozás a családhoz")}</h2>
              <p className="capture-help">
                {invitationFamilyName
                  ? (appLocale === 'da-DK'
                    ? `Du er inviteret til familien ${invitationFamilyName}.`
                    : `Meghívást kaptál ehhez a családhoz: ${invitationFamilyName}.`)
                  : tr("Meghívást kaptál egy családhoz.")}{' '}
                {tr("Add meg, hogyan szólítsunk.")}
              </p>

              <form className="setup-form" onSubmit={handleAcceptOwnerInvitation}>
                <label>
                  {tr("Hogyan szólítsunk?")}
                  <input
                    type="text"
                    value={invitationDisplayName}
                    onChange={(event) => setInvitationDisplayName(event.target.value)}
                    placeholder={tr("Például: Anna")}
                    required
                  />
                </label>

                <label>
                  {tr("Jelszó")}
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={invitationPassword}
                    onChange={(event) => setInvitationPassword(event.target.value)}
                    minLength={6}
                    placeholder={tr("Legalább 6 karakter")}
                    required
                  />
                </label>

                <button
                  className="primary-button"
                  type="submit"
                  disabled={
                    invitationBusy
                    || !invitationDisplayName.trim()
                    || invitationPassword.length < 6
                  }
                >
                  {invitationBusy ? tr("Csatlakozás…") : tr("Csatlakozás a családhoz")}
                </button>
              </form>

              {invitationError && <p className="notice error">{invitationError}</p>}
            </section>
          )}

          {!familyLoading && !familyName && !familyError && !pendingOwnerInvitation && (
            <section className="setup-block" aria-label={tr("Család létrehozása")}>
              <h2>{tr("Család létrehozása")}</h2>
              <p className="capture-help">
                {tr("Add meg a család nevét és azt, hogyan szólítsunk. A többit később is beállíthatod.")}
              </p>

              <form className="setup-form" onSubmit={handleFamilySetup}>
                <label>
                  {tr("Család neve")}
                  <input
                    type="text"
                    value={setupFamilyName}
                    onChange={(event) => setSetupFamilyName(event.target.value)}
                    placeholder={tr("Például: Kovács család")}
                    required
                  />
                </label>

                <label>
                  {tr("Hogyan szólítsunk?")}
                  <input
                    type="text"
                    value={setupDisplayName}
                    onChange={(event) => setSetupDisplayName(event.target.value)}
                    placeholder={tr("Például: Anna")}
                    required
                  />
                </label>

                <details>
                  <summary>{tr("További beállítások (opcionális)")}</summary>

                  <label>
                    {tr("További családtagok")}
                    <textarea
                      value={setupManagedMembers}
                      onChange={(event) => setSetupManagedMembers(event.target.value)}
                      placeholder={tr("Például: Mamus, Bence")}
                      rows={2}
                    />
                    <small>{tr("Vesszővel vagy új sorral válaszd el a neveket.")}</small>
                  </label>

                  <label>
                    {tr("Másik családi felhasználó e-mailje")}
                    <input
                      type="email"
                      value={setupSecondOwnerEmail}
                      onChange={(event) => setSetupSecondOwnerEmail(event.target.value)}
                      placeholder={tr("Opcionális")}
                    />
                  </label>
                </details>

                <button
                  className="primary-button"
                  type="submit"
                  disabled={setupBusy || !setupFamilyName.trim() || !setupDisplayName.trim()}
                >
                  {setupBusy ? tr("Létrehozás…") : tr("Család létrehozása")}
                </button>
              </form>

              {setupMessage && <p className="notice success">{setupMessage}</p>}
              {setupError && <p className="notice error">{setupError}</p>}
            </section>
          )}

          {familyName && pushContextLoading && (
            <section className="push-context-card" aria-live="polite">
              <strong>{tr("Értesítés betöltése…")}</strong>
            </section>
          )}

          {familyName && pushContext && (
            <section className="push-context-card" aria-label={tr("Megnyitott értesítés")}>
              <div className="push-context-header">
                <strong>{currentPushCopy?.title ?? tr(pushContext.title)}</strong>
                <button
                  className="push-context-close"
                  type="button"
                  onClick={() => setPushContext(null)}
                  aria-label={tr("Értesítés bezárása")}
                >
                  ×
                </button>
              </div>
              {pushContext.type === 'briefing' ? (
                <div className="briefing-content">
                  {(currentPushCopy?.lines ?? pushContext.message.split('\n'))
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0)
                    .map((line, index) => {
                      if (index === 0) {
                        return <p className="briefing-greeting" key={`briefing-${index}`}>{line}</p>
                      }

                      const match = line.match(/^(Ma|Lejárt|Emlékeztető):\s*(.*)$/)
                      if (!match) {
                        return <div className="briefing-row" key={`briefing-${index}`}>{line}</div>
                      }

                      const labelClass = match[1] === 'Lejárt'
                        ? 'overdue'
                        : match[1] === 'Ma'
                          ? 'today'
                          : 'reminder'

                      return (
                        <div className="briefing-row" key={`briefing-${index}`}>
                          <span className={`briefing-label ${labelClass}`}>{tr(match[1])}</span>
                          <span>{match[2]}</span>
                        </div>
                      )
                    })}
                </div>
              ) : (
                <p>{currentPushCopy?.lines[0] ?? pushContext.message}</p>
              )}
              {pushContext.type === 'reminder' && pushContext.item_id && (
                <button
                  className="secondary-button push-context-action"
                  type="button"
                  onClick={() => startReminderEdit(
                    pushContext.item_id as string,
                    pushContext.item_title ?? pushContext.message,
                  )}
                  disabled={createBusy}
                >
                  {tr("Emlékeztető módosítása")}
                </button>
              )}
            </section>
          )}

          {familyName && (
            <section className="capture-block capture-primary" aria-label={tr("Kommunikáció")}>
              <h2>{t('captureHeading')}</h2>
              <p className="capture-help">
                {appLocale === 'da-DK' ? t('captureDescription') : <>Írd be vagy diktáld természetesen. Például: „{exampleText}” vagy „Mik a nyitott ügyeink?”</>}
              </p>


              <form className="capture-form" onSubmit={handleMessage}>
                <div className="capture-input-shell">
                  <textarea
                    value={createMessage}
                    onChange={(event) => {
                      setCreateMessage(event.target.value)
                      // Az emlékeztető beírása nem törölheti a mentésre váró ügyet.
                      // Máskor az új szöveg továbbra is új értelmezést indít.
                      const addingReminderToDraft = Boolean(
                        createDraft?.due_date && !createDraft.first_reminder_at,
                      )
                      if (!addingReminderToDraft) setCreateDraft(null)
                      setCompleteDraft(null)
                      setUpdateDraft(null)
                      setReminderUpdateDraft(null)
                      setDeleteDraft(null)
                      setCreateError(null)
                      setCreateSuccess(null)
                      if (!reminderEditTarget && !dateEditTarget) setAssistantAnswer(null)
                      setQueryResults([])
                      setVoiceError(null)
                    }}
                    placeholder={dateEditTarget ? tr("Az ügy új dátuma/időpontja…") : reminderEditTarget ? tr("Az új emlékeztetés időpontja…") : tr("Mondd vagy írd le, mit intézzünk…")}
                    rows={4}
                    disabled={createBusy || voiceListening || voiceTranscribing}
                  />

                  <button
                    className={voiceListening ? 'voice-button listening' : 'voice-button'}
                    type="button"
                    onClick={handleVoiceInput}
                    disabled={createBusy || voiceTranscribing}
                    aria-label={
                      voiceTranscribing
                        ? tr("Hang átírása")
                        : voiceListening
                          ? tr("Felvétel leállítása")
                          : tr("Diktálás indítása")
                    }
                    title={
                      voiceTranscribing
                        ? tr("Átírás…")
                        : voiceListening
                          ? tr("Felvétel leállítása")
                          : tr("Diktálás")
                    }
                  >
                    {voiceTranscribing ? (
                      <span className="voice-spinner" aria-hidden="true" />
                    ) : voiceListening ? (
                      <span className="stop-symbol" aria-hidden="true" />
                    ) : (
                      <svg
                        className="microphone-icon"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0M12 16v4m-3 0h6"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                </div>

                <div className="capture-actions">
                  <small>
                    {voiceTranscribing
                      ? tr("Átírom a felvételt…")
                      : voiceListening
                        ? tr("Felvétel folyamatban. Ha kész vagy, koppints újra a mikrofonra.")
                        : tr("Koppints a mikrofonra, mondd el, majd koppints újra a leállításhoz.")}
                  </small>
                  <button
                    className="primary-button send-button"
                    type="submit"
                    disabled={
                      createBusy
                      || voiceListening
                      || voiceTranscribing
                      || !createMessage.trim()
                    }
                  >
                    {createBusy ? (appLocale === 'da-DK' ? 'Behandler…' : tr("Feldolgozás…")) : t('send')}
                  </button>
                </div>

                {voiceError && <p className="voice-error">{voiceError}</p>}
              </form>

              {assistantAnswer && (
                <div className="assistant-answer">
                  <strong>{tr("Válasz:")}</strong>
                  <p>{assistantAnswer}</p>
                </div>
              )}

              {completeCandidates.length > 0 && (
                <>
                  <p className="candidate-helper">
                    {tr("Több egyező nyitott ügyet találtam. Koppints arra, amelyiket készre jelöljem.")}
                  </p>
                  <div className="complete-candidates" aria-label={tr("Lezárható találatok")}>
                  {completeCandidates.map((candidate) => (
                    <button
                      className="complete-candidate-button"
                      type="button"
                      key={candidate.id}
                      onClick={() => void handleCompleteCandidate(candidate)}
                      disabled={createBusy}
                    >
                      {candidate.label}
                    </button>
                  ))}
                  </div>
                </>
              )}

              {queryResults.length > 0 && (
                <div className="query-results" aria-label={tr("Találatok")}>
                  {queryResults.map((item) => {
                    const ownerPrefix = item.is_other_owner && item.responsible_display_name
                      ? `${item.responsible_display_name}:`
                      : null
                    const labelWithoutOwner = ownerPrefix && item.label.startsWith(ownerPrefix)
                      ? item.label.slice(ownerPrefix.length).trimStart()
                      : item.label

                    const classes = [
                      'query-item',
                      item.is_other_owner ? 'other-owner' : '',
                      item.is_overdue ? 'overdue' : '',
                    ].filter(Boolean).join(' ')

                    return (
                      <div
                        className={classes}
                        key={item.id}
                      >
                        <div className="query-label">
                          {item.is_overdue && (
                            <span className="overdue-badge">{tr("LEJÁRT")}</span>
                          )}
                          {ownerPrefix && (
                            <strong className="query-owner-name">{item.responsible_display_name}:</strong>
                          )}{' '}
                          {labelWithoutOwner}
                          {item.status === 'open' && item.reminder_missing && (
                            <strong> – {tr("Nincs emlékeztető")}</strong>
                          )}
                        </div>
                        {item.status === 'open' && (
                          <div className="confirmation-actions">
                            <button
                              className="query-action-button"
                              type="button"
                              onClick={() => startDateEdit(item.id, item.title)}
                              disabled={createBusy}
                            >
                              {tr("Dátum/idő módosítása")}
                            </button>
                            <button
                              className="query-action-button"
                              type="button"
                              onClick={() => startReminderEdit(item.id, item.title)}
                              disabled={createBusy}
                            >
                              {item.reminder_missing ? tr("Emlékeztető beállítása") : tr("Emlékeztető módosítása")}
                            </button>
                            {item.is_overdue && (
                              <button
                                className="query-action-button query-complete-button"
                                type="button"
                                onClick={() => void handleCompleteCandidate(item)}
                                disabled={createBusy}
                              >
                                <span aria-hidden="true">✓</span>
                                {tr("Késznek jelölöm")}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {deleteDraft && (
                <div className="confirmation-card delete-confirmation">
                  <strong>{tr("Törlés megerősítése:")}</strong>
                  <p>{deleteDraft.confirmation_text}</p>
                  <div className="confirmation-actions">
                    <button
                      className="danger-button"
                      type="button"
                      onClick={handleConfirmDelete}
                      disabled={createBusy}
                    >
                      {tr("Igen, töröld")}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={handleCancelCreate}
                      disabled={createBusy}
                    >
                      {tr("Mégse")}
                    </button>
                  </div>
                </div>
              )}

              {reminderUpdateDraft && (
                <div className="confirmation-card">
                  <strong>{tr("Emlékeztető módosításának megerősítése:")}</strong>
                  <p>{reminderUpdateDraft.confirmation_text}</p>
                  <div className="confirmation-actions">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={handleConfirmReminderUpdate}
                      disabled={createBusy}
                    >
                      {tr("Igen, módosítsd")}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={handleCancelCreate}
                      disabled={createBusy}
                    >
                      {tr("Mégse")}
                    </button>
                  </div>
                </div>
              )}

              {updateDraft && (
                <div className="confirmation-card">
                  <strong>{tr("Megerősítés:")}</strong>
                  <p>{updateDraft.confirmation_text}</p>
                  <div className="confirmation-actions">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={handleConfirmUpdate}
                      disabled={createBusy}
                    >
                      {tr("Igen, módosítsd")}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={handleCancelCreate}
                      disabled={createBusy}
                    >
                      {tr("Mégse")}
                    </button>
                  </div>
                </div>
              )}

              {reminderFollowUp && (
                <div className="confirmation-card">
                  <strong>{tr("Mi legyen az emlékeztetővel?")}</strong>
                  <p>
                    {reminderFollowUp.reminder_at
                      ? (appLocale === 'da-DK'
                        ? `Opgavens tidspunkt er ændret, men påmindelsen er stadig sat til ${new Date(reminderFollowUp.reminder_at).toLocaleString('da-DK', { dateStyle: 'long', timeStyle: 'short' })}. Vil du beholde, ændre eller slå den fra?`
                        : `A feladat időpontja megváltozott, de az emlékeztető maradt: ${new Date(reminderFollowUp.reminder_at).toLocaleString('hu-HU', { dateStyle: 'long', timeStyle: 'short' })}. Megtartod, módosítod vagy kikapcsolod?`)
                      : tr("A feladat időpontja megváltozott. Ehhez az ügyhöz nincs beállított emlékeztető. Szeretnél beállítani egyet?")}
                  </p>
                  <div className="confirmation-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => setReminderFollowUp(null)}
                      disabled={createBusy}
                    >
                      {reminderFollowUp.reminder_at ? tr("Maradjon az eredeti") : tr("Maradjon emlékeztető nélkül")}
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => startReminderEdit(reminderFollowUp.id, reminderFollowUp.title)}
                      disabled={createBusy}
                    >
                      {reminderFollowUp.reminder_at ? tr("Emlékeztető módosítása") : tr("Emlékeztető beállítása")}
                    </button>
                    {reminderFollowUp.reminder_at && (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void handleDisableReminderFromFollowUp()}
                        disabled={createBusy}
                      >
                        {tr("Emlékeztető kikapcsolása")}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {completeDraft && (
                <div className="confirmation-card">
                  <strong>{tr("Megerősítés:")}</strong>
                  <p>{completeDraft.confirmation_text}</p>
                  <div className="confirmation-actions">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={handleConfirmComplete}
                      disabled={createBusy}
                    >
                      {tr("Igen, jelöld késznek")}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={handleCancelCreate}
                      disabled={createBusy}
                    >
                      {tr("Mégse")}
                    </button>
                  </div>
                </div>
              )}

              {createDraft && (
                <div className="confirmation-card">
                  <strong>{tr("Ezt értettem:")}</strong>
                  <p>{createDraft.confirmation_text}</p>
                  {createDraft.due_date && !createDraft.first_reminder_at && (
                    <p className="confirmation-hint">
                      {tr("Az ügy többi adata megmarad. Mondd vagy írd be csak az emlékeztetést, például: „aznap 18-kor” vagy „előző nap 18-kor”, majd nyomd meg a Küldést.")}
                    </p>
                  )}
                  <div className="confirmation-actions">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={handleConfirmCreate}
                      disabled={createBusy}
                    >
                      {createDraft.due_date && !createDraft.first_reminder_at
                        ? tr("Rögzítés emlékeztető nélkül")
                        : tr("Igen, rögzítsd")}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={handleCancelCreate}
                      disabled={createBusy}
                    >
                      {tr("Mégse")}
                    </button>
                  </div>
                </div>
              )}

              {createSuccess && <p className="notice success">{createSuccess}</p>}
              {createError && <p className="notice error">{createError}</p>}
            </section>
          )}

          {!familyLoading && familyName && (
            <details className="secondary-details">
              <summary>{t('familyMembers')}</summary>
              <ul className="member-list">
                {familyMembers.map((member) => (
                  <li key={`${member.family_id}-${member.display_name}`}>
                    <span>{member.display_name}</span>
                    <small>
                      {member.member_kind === 'active' ? tr("Családi felhasználó") : tr("Kezelt családtag")}
                    </small>
                  </li>
                ))}
              </ul>

              <form className="setup-form" onSubmit={handleAddFamilyMember}>
                <label>
                  {tr("Új családtag")}
                  <input
                    type="text"
                    value={newFamilyMemberName}
                    onChange={(event) => setNewFamilyMemberName(event.target.value)}
                    placeholder={tr("Például: Bence")}
                  />
                </label>
                <button
                  className="secondary-button"
                  type="submit"
                  disabled={familyActionBusy || !newFamilyMemberName.trim()}
                >
                  {tr("Kezelt családtag hozzáadása")}
                </button>
              </form>

              {familyMembers.filter((member) => member.member_kind === 'active').length < 2 && (
                <form className="setup-form" onSubmit={handleInviteSecondOwner}>
                  <label>
                    {tr("Másik családi felhasználó meghívása")}
                    <input
                      type="email"
                      value={secondOwnerInviteEmail}
                      onChange={(event) => setSecondOwnerInviteEmail(event.target.value)}
                      placeholder={tr("E-mail-cím")}
                    />
                  </label>
                  <button
                    className="secondary-button"
                    type="submit"
                    disabled={familyActionBusy || !secondOwnerInviteEmail.trim()}
                  >
                    {tr("Meghívó küldése")}
                  </button>
                </form>
              )}

              {familyActionMessage && <p className="notice success">{familyActionMessage}</p>}
              {familyActionError && <p className="notice error">{familyActionError}</p>}
            </details>
          )}

          {familyName && (
            <details className="secondary-details settings-details">
              <summary>{t('settings')}</summary>
              {settingsLoading ? (
                <p className="settings-hint">{t('loading')}</p>
              ) : (
                <div className="settings-form">
                  <label className="settings-time">
                    <span>{t('language')}</span>
                    <select
                      value={appLocale}
                      disabled={localeBusy}
                      onChange={(event) => void handleLocalePreference(event.target.value as AppLocale)}
                    >
                      <option value="hu-HU">Magyar</option>
                      <option value="da-DK">Dansk</option>
                    </select>
                  </label>
                  <div className="locale-device-details">
                    {deviceTimezone === settings.timezone ? (
                      <small>
                        <span aria-hidden="true">✓ </span>
                        {t('timezone')}: {settings.timezone} – {t('timezoneMatches')}
                      </small>
                    ) : deviceTimezone ? (
                      <>
                        <small>{t('detectedTimezone')}: {deviceTimezone}</small>
                        <small>{t('savedTimezone')}: {settings.timezone}</small>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={localeBusy}
                          onClick={() => void handleLocalePreference(appLocale, true)}
                        >
                          {t('applyTimezone')}
                        </button>
                      </>
                    ) : (
                      <small>
                        {t('savedTimezone')}: {settings.timezone} – {t('noDeviceTimezone')}
                      </small>
                    )}
                    {localeMessage && <small className="locale-success">{localeMessage}</small>}
                    {localeError && <small className="locale-error">{localeError}</small>}

                  </div>
                  <label className="settings-time appearance-setting">
                    <span>{t('appearance')}</span>
                    <select
                      value={appearanceMode}
                      onChange={(event) => setAppearanceMode(event.target.value as AppearanceMode)}
                    >
                      <option value="system">{t('systemAppearance')}</option>
                      <option value="light">{t('lightAppearance')}</option>
                      <option value="dark">{t('darkAppearance')}</option>
                    </select>
                  </label>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={settings.briefing_enabled}
                      disabled={settingsBusy}
                      onChange={(event) => void saveSettingChange({
                        briefing_enabled: event.target.checked,
                      })}
                    />
                    <span>{t('morningBriefing')}</span>
                  </label>

                  <label className="settings-time">
                    <span>{t('briefingTime')}</span>
                    <input
                      type="time"
                      value={settings.briefing_time}
                      disabled={!settings.briefing_enabled || settingsBusy}
                      onChange={(event) => void saveSettingChange({
                        briefing_time: event.target.value,
                      })}
                      required
                    />
                  </label>

                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={settings.notify_partner_on_complete}
                      disabled={settingsBusy}
                      onChange={(event) => void saveSettingChange({
                        notify_partner_on_complete: event.target.checked,
                      })}
                    />
                    <span>{t('partnerDone')}</span>
                  </label>

                  {settingsError && <p className="notice error">{settingsError}</p>}

                  {(settingsBusy || settingsMessage) && (
                    <p className="settings-hint" role="status">
                      {settingsBusy ? t('saving') : settingsMessage}
                    </p>
                  )}
                </div>
              )}
            </details>
          )}

          {familyName && !isStandalone && (
            <details className="secondary-details">
              <summary>{t('install')}</summary>
              <section className="push-settings" aria-label={tr("Telepítés a telefonra")}>
                <div>
                  <strong>{tr("AI családi asszisztens a kezdőképernyőn")}</strong>
                  {installPrompt ? (
                    <small>
                      {tr("Telepítsd az alkalmazást, hogy a telefonodon önálló appként tudd megnyitni.")}
                    </small>
                  ) : isIos ? (
                    <small>
                      {tr("iPhone-on vagy iPaden Safari alatt: Megosztás → Hozzáadás a Főképernyőhöz.")}
                    </small>
                  ) : (
                    <small>
                      {tr("A böngésző menüjében válaszd a Telepítés vagy a Hozzáadás a kezdőképernyőhöz lehetőséget.")}
                    </small>
                  )}
                </div>

                {installPrompt && (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={handleInstallApp}
                  >
                    {tr("Telepítés")}
                  </button>
                )}
              </section>
            </details>
          )}

          <details className="secondary-details account-details">
            <summary>{t('account')}</summary>

            <dl className="account">
              <div>
                <dt>{t('signedIn')}</dt>
                <dd>{session.user.email ?? tr("Ismeretlen e-mail")}</dd>
              </div>
            </dl>

            {familyName && (
              <section className="push-settings" aria-label={tr("Értesítések")}>
                <div>
                  <strong>{t('notifications')}</strong>
                  {pushStatus === 'loading' && <small>{tr("Ellenőrzés…")}</small>}
                  {pushStatus === 'enabled' && <small className="push-enabled">{t('enabled')}</small>}
                  {pushStatus === 'blocked' && <small>{tr("Az értesítések le vannak tiltva a böngésző/PWA beállításaiban.")}</small>}
                  {pushStatus === 'unsupported' && <small>{tr("Ez a böngésző vagy eszköz nem támogatja a webes push értesítéseket.")}</small>}
                  {pushStatus === 'error' && <small>{pushError ?? tr("A push szolgáltatás nem érhető el.")}</small>}
                  {pushStatus === 'ready' && (
                    <small>
                      {typeof Notification !== 'undefined' && Notification.permission === 'granted'
                        ? tr("Az értesítések engedélyezettek, de ezen az eszközön még nem működik a pushküldés.")
                        : tr("Kapcsold be, hogy ezen az eszközön megérkezzenek a családi értesítések.")}
                    </small>
                  )}
                </div>

                {pushStatus === 'ready' && (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={handleEnablePush}
                    disabled={pushBusy}
                  >
                    {pushBusy ? tr("Ellenőrzés…") : typeof Notification !== 'undefined' && Notification.permission === 'granted'
                      ? tr("Értesítések újrapróbálása")
                      : tr("Értesítések bekapcsolása")}
                  </button>
                )}
              </section>
            )}

            <button className="secondary-button sign-out-button" type="button" onClick={handleSignOut}>
              {t('signOut')}
            </button>
          </details>

          {familyName && (
            <button
              className="secondary-button help-entry-button"
              type="button"
              onClick={() => {
                setShowHelp(true)
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }}
            >
              {t('help')}
            </button>
          )}

          {errorMessage && <p className="notice error">{errorMessage}</p>}
        </section>
      </main>
    )
  }


  if (confirmationEmail) {
    return (
      <main className="shell">
        <section className="card">
          <p className="eyebrow">{tr("AI családi asszisztens")}</p>
          <h1>{tr("Nézd meg az e-mailed")}</h1>
          <p className="lead">
            {appLocale === 'da-DK' ? 'Vi har sendt en bekræftelsesmail til:' : 'Megerősítő e-mailt küldtünk ide:'}{' '}
            <strong>{confirmationEmail}</strong>
          </p>

          <p className="notice success">
            {tr("Nyisd meg a levelet, és koppints az „E-mail-cím megerősítése” gombra.")}
          </p>

          <p className="capture-help">
            {tr("Ha pár percen belül nem látod a levelet, nézd meg a Spam vagy Levélszemét mappát is. Ha több megerősítő levelet kaptál, mindig a legfrissebb levélben lévő linket használd.")}
          </p>

          {resendMessage && <p className="notice success">{resendMessage}</p>}
          {errorMessage && <p className="notice error">{errorMessage}</p>}

          <div className="auth-form">
            <button
              className="secondary-button"
              type="button"
              onClick={handleResendConfirmation}
              disabled={resendBusy || resendCooldown > 0}
            >
              {resendBusy
                ? tr("Küldés…")
                : resendCooldown > 0
                  ? (appLocale === 'da-DK'
                    ? `Send igen om ${resendCooldown} sek.`
                    : `Újraküldés ${resendCooldown} mp múlva`)
                  : tr("Megerősítő e-mail újraküldése")}
            </button>

            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setConfirmationEmail(null)
                setResendMessage(null)
                setMode('sign-in')
              }}
            >
              {tr("Vissza a belépéshez")}
            </button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">{tr("AI családi asszisztens")}</p>
        <h1>{tr("AI családi asszisztens")}</h1>
        <p className="lead">
          {mode === 'sign-in'
            ? tr("Jelentkezz be az AI családi asszisztensbe.")
            : tr("Hozd létre az első felhasználói fiókot.")}
        </p>

        {authRedirectError && <p className="notice error">{tr(authRedirectError)}</p>}

        <div className="auth-tabs" aria-label={tr("Belépési mód")}>
          <button
            className={mode === 'sign-in' ? 'tab active' : 'tab'}
            type="button"
            onClick={() => {
              setMode('sign-in')
              setMessage(null)
              setErrorMessage(null)
            }}
          >
            {tr("Belépés")}
          </button>
          <button
            className={mode === 'sign-up' ? 'tab active' : 'tab'}
            type="button"
            onClick={() => {
              setMode('sign-up')
              setMessage(null)
              setErrorMessage(null)
            }}
          >
            {tr("Regisztráció")}
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            E-mail
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>

          <label>
            {tr("Jelszó")}
            <input
              type="password"
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={6}
              required
            />
          </label>

          {message && <p className="notice success">{message}</p>}
          {errorMessage && <p className="notice error">{errorMessage}</p>}

          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting
              ? tr("Folyamatban…")
              : mode === 'sign-in'
                ? tr("Belépés")
                : tr("Fiók létrehozása")}
          </button>
        </form>
      </section>
    </main>
  )
}
