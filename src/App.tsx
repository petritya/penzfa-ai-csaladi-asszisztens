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

type DeleteCandidate = Pick<CompleteCandidate, 'id' | 'title' | 'label'> & {
  status?: 'open' | 'done'
}

type ReminderEditTarget = {
  id: string
  title: string
}

type NoteEditTarget = ReminderEditTarget & {
  due_date: string | null
  due_time: string | null
  reminder_at?: string | null
}

type ReminderFollowUp = ReminderEditTarget & {
  reminder_at: string | null
  due_date?: string | null
  due_time?: string | null
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
  briefing_date?: string | null
}

type QueryResultItem = {
  id: string
  title: string
  label: string
  notes?: string | null
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

type CalendarImportCandidate = {
  event_id: string
  title: string
  notes: string | null
  due_date: string
  due_time: string | null
  expires_at: string
}

type CalendarChangeCandidate = {
  id: string
  event_id: string
  item_id: string
  change_type: 'update' | 'delete'
  title: string | null
  notes: string | null
  due_date: string | null
  due_time: string | null
  discovered_at: string
  local_item?: { title: string; due_date: string | null; due_time: string | null } | null
}

type CalendarPushRequest = { kind: 'change' | 'import'; changeId: string | null }

// A push értesítésből érkezett hivatkozás régebbi és új formáját is kezeljük.
function readCalendarPushRequest(): CalendarPushRequest | null {
  const params = new URLSearchParams(window.location.search)
  const kind = params.get('push')
  if (kind === 'calendar-change') return { kind: 'change', changeId: params.get('change_id') }
  if (kind === 'calendar-import') return { kind: 'import', changeId: null }
  return null
}

type CalendarExportDraft = {
  item_id: string
  title: string
  date: string
  time?: string | null
  notes: string | null
  expected_updated_at: string
  resend?: boolean
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

function currentDateAndTimeInZone(timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  }
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
  const [calendarConnected, setCalendarConnected] = useState<boolean | null>(null)
  const [calendarAutoExportEnabled, setCalendarAutoExportEnabled] = useState(false)
  const [calendarAutoImportEnabled, setCalendarAutoImportEnabled] = useState(false)
  const [calendarImportNeedsReauth, setCalendarImportNeedsReauth] = useState(false)
  const [calendarImportCandidates, setCalendarImportCandidates] = useState<CalendarImportCandidate[]>([])
  const [calendarChangeCandidates, setCalendarChangeCandidates] = useState<CalendarChangeCandidate[]>([])
  const [calendarChangeBusy, setCalendarChangeBusy] = useState(false)
  const [calendarChangeError, setCalendarChangeError] = useState<string | null>(null)
  const [calendarChangeNotice, setCalendarChangeNotice] = useState<string | null>(null)
  const [calendarPushRequest, setCalendarPushRequest] = useState<CalendarPushRequest | null>(
    () => readCalendarPushRequest(),
  )
  const [calendarPushLoading, setCalendarPushLoading] = useState(false)
  const [calendarPushLoaded, setCalendarPushLoaded] = useState(false)
  const [calendarImportBusy, setCalendarImportBusy] = useState(false)
  const [calendarImportLoading, setCalendarImportLoading] = useState(false)
  const [calendarImportNotice, setCalendarImportNotice] = useState<string | null>(null)
  const [calendarImportError, setCalendarImportError] = useState<string | null>(null)
  const [calendarNeedsReauth, setCalendarNeedsReauth] = useState(false)
  const [calendarExportDraft, setCalendarExportDraft] = useState<CalendarExportDraft | null>(null)
  const [calendarExportBusy, setCalendarExportBusy] = useState(false)
  const [calendarExportedItemIds, setCalendarExportedItemIds] = useState<string[] | null>(null)
  const [calendarExportStatusError, setCalendarExportStatusError] = useState<string | null>(null)
  const [calendarExportFeedback, setCalendarExportFeedback] = useState<{ kind: 'success' | 'warning'; message: string } | null>(null)
  const [calendarExportError, setCalendarExportError] = useState<string | null>(null)
  const [calendarBusy, setCalendarBusy] = useState(false)
  const [calendarNotice, setCalendarNotice] = useState<string | null>(null)
  const [calendarError, setCalendarError] = useState<string | null>(null)
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
  const [reminderEditTarget, setReminderEditTarget] = useState<NoteEditTarget | null>(null)
  const [dateEditTarget, setDateEditTarget] = useState<NoteEditTarget | null>(null)
  const [noteEditTarget, setNoteEditTarget] = useState<NoteEditTarget | null>(null)
  const [reminderFollowUp, setReminderFollowUp] = useState<ReminderFollowUp | null>(null)
  const [deleteDraft, setDeleteDraft] = useState<DeleteDraft | null>(null)
  const [deleteCandidates, setDeleteCandidates] = useState<DeleteCandidate[]>([])
  const [calendarDeleteFollowUp, setCalendarDeleteFollowUp] = useState<{id:string;title:string}|null>(null)
  const [calendarDeleteBusy, setCalendarDeleteBusy] = useState(false)
  const [calendarDeleteError, setCalendarDeleteError] = useState<string|null>(null)
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
  // Prevents two quick taps from completing the same item twice.
  const completionRequestRef = useRef(false)
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
    setNoteEditTarget(null)
    setReminderFollowUp(null)
    setDeleteDraft(null)
    setDeleteCandidates([])
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

  // A Google Naptár döntése után csak röviden jelenik meg a visszajelzés.
  // A naptárbeállítások sikeres visszajelzése öt másodperc után eltűnik.
  useEffect(() => {
    if (!calendarNotice) return
    const timer = window.setTimeout(() => setCalendarNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [calendarNotice])

  useEffect(() => {
    if (!calendarImportNotice) return
    const timer = window.setTimeout(() => setCalendarImportNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [calendarImportNotice])

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
          briefing_date: data.briefing_date ? String(data.briefing_date) : null,
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

  // A briefing DB-ben mentve van, ezért push-kimaradáskor is megjelenik,
  // amikor a felhasználó megnyitja vagy előtérbe hozza az alkalmazást.
  // Ez nem újabb push küldése, és nem állítja, hogy a push kézbesült.
  useEffect(() => {
    const client = supabase
    const userId = session?.user.id
    if (!client || !userId || !familyName || !settings.briefing_enabled) return
    // A háttérbetöltő async függvényben is biztosan nem-null kliens kell.
    const activeClient = client

    let cancelled = false
    let loading = false
    let shownDate: string | null = null

    async function loadTodayBriefing() {
      if (cancelled || loading || document.visibilityState !== 'visible') return
      if (new URLSearchParams(window.location.search).has('push')) return

      const { date, time } = currentDateAndTimeInZone(settings.timezone || 'Europe/Budapest')
      if (time < settings.briefing_time.slice(0, 5) || shownDate === date) return
      const dismissedKey = `penzfa-briefing-dismissed:${userId}:${date}`
      if (window.localStorage.getItem(dismissedKey) === '1') return

      loading = true
      const { data, error } = await activeClient.functions.invoke('core', {
        body: { action: 'push_context', type: 'briefing', briefing_date: date },
      })
      loading = false
      if (cancelled || error || data?.status !== 'ok' || !data?.message) return
      shownDate = date

      setPushContext((current) => {
        if (current || window.localStorage.getItem(dismissedKey) === '1') return current
        return {
          type: 'briefing',
          title: String(data.title ?? 'Reggeli briefing'),
          message: String(data.message),
          item_id: null,
          item_title: null,
          briefing_date: date,
        }
      })
    }

    const onResume = () => { void loadTodayBriefing() }
    void loadTodayBriefing()
    document.addEventListener('visibilitychange', onResume)
    const interval = window.setInterval(onResume, 60_000)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onResume)
      window.clearInterval(interval)
    }
  }, [session?.user.id, familyName, settings.briefing_enabled, settings.briefing_time, settings.timezone])

  // A már mentett briefing-szöveg a nyelvváltás után is az aktuális
  // felhasználói nyelven jelenik meg. A forrás és minden ügyadat változatlan.
  useEffect(() => {
    if (!supabase || !session || !pushContext) {
      setLocalizedPush(null)
      return
    }
    // A szerveren eltárolt briefing magyar szöveg. Magyar felületen
    // ne fordítsuk újra AI-val: a fölösleges fordítás idegen nyelvű
    // (pl. német) választ is eredményezhet.
    if (appLocale === 'hu-HU' && pushContext.type === 'briefing') {
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

  useEffect(() => {
    if (!supabase || !session?.user.id || !familyName) {
      setCalendarConnected(null)
      setCalendarAutoImportEnabled(false)
      setCalendarImportCandidates([])
      setCalendarAutoExportEnabled(false)
      setCalendarNeedsReauth(false)
      return
    }
    let active = true

    const checkConnection = async () => {
      const params = new URL(window.location.href)
      const ticket = params.searchParams.get('google_calendar_ticket')
      const returnedState = params.searchParams.get('google_calendar_state')
      const result = params.searchParams.get('google_calendar')

      if (ticket) {
        // A Google callback csak akkor zárható le, ha ugyanaz a böngésző
        // indította az engedélykérést. A Supabase ezen felül a user_id-t is ellenőrzi.
        const expectedState = window.sessionStorage.getItem('penzfa-calendar-oauth-state')
        window.sessionStorage.removeItem('penzfa-calendar-oauth-state')
        params.searchParams.delete('google_calendar_ticket')
        params.searchParams.delete('google_calendar_state')
        window.history.replaceState(window.history.state, '', params.pathname + params.search + params.hash)

        if (returnedState && expectedState === returnedState) {
          const completed = await supabase!.functions.invoke('google-calendar-oauth', {
            body: { action: 'complete', ticket },
          })
          if (!active) return
          setCalendarNotice(completed.error || completed.data?.error
            ? (appLocale === 'da-DK' ? 'Google-forbindelsen kunne ikke afsluttes.' : 'Nem sikerült befejezni a Google-összekapcsolást.')
            : (appLocale === 'da-DK' ? 'Google Kalender er forbundet.' : 'Google Naptár összekapcsolva.'))
        } else {
          setCalendarNotice(appLocale === 'da-DK'
            ? 'Google-autorisationen blev ikke startet i denne browser.'
            : 'A Google engedélykérést nem ebben az alkalmazás-munkamenetben indítottad.')
        }
      } else if (result === 'error') {
        setCalendarNotice(appLocale === 'da-DK'
          ? 'Google-autorisation blev afbrudt eller mislykkedes.'
          : 'A Google engedélykérés megszakadt vagy nem sikerült.')
        params.searchParams.delete('google_calendar')
        window.history.replaceState(window.history.state, '', params.pathname + params.search + params.hash)
      }

      const { data, error } = await supabase!.functions.invoke('google-calendar-oauth', {
        body: { action: 'status' },
      })
      if (!active) return
      if (error || data?.error) {
        setCalendarError(appLocale === 'da-DK'
          ? 'Google Kalender-forbindelsen kunne ikke kontrolleres.'
          : 'A Google Naptár kapcsolatát nem sikerült ellenőrizni.')
      } else {
        setCalendarConnected(Boolean(data?.connected))
        setCalendarAutoImportEnabled(Boolean(data?.auto_import_enabled))
        setCalendarImportNeedsReauth(data?.auto_import_error === 'reauthorize_required')
        if (data?.connected) {
          const imports = await supabase!.functions.invoke('google-calendar-oauth', {
            body: { action: 'list_calendar_imports' },
          })
          if (!active) return
          if (!imports.error && Array.isArray(imports.data?.items)) {
            setCalendarImportCandidates(imports.data.items as CalendarImportCandidate[])
          }
          const changes = await supabase!.functions.invoke('google-calendar-oauth', {
            body: { action: 'list_calendar_changes' },
          })
          if (!active) return
          if (!changes.error && Array.isArray(changes.data?.items)) {
            setCalendarChangeCandidates(changes.data.items as CalendarChangeCandidate[])
          }
        } else {
          setCalendarImportCandidates([])
          setCalendarChangeCandidates([])
        }
        setCalendarAutoExportEnabled(Boolean(data?.auto_export_enabled))
        setCalendarNeedsReauth(data?.auto_export_error === 'reauthorize_required')
        setCalendarError(null)
      }
    }
    void checkConnection()
    return () => { active = false }
  }, [session?.user.id, familyName])

  async function handleConnectCalendar() {
    if (!supabase || !session || calendarBusy) return
    setCalendarBusy(true)
    setCalendarError(null)
    setCalendarNotice(null)
    const { data, error } = await supabase.functions.invoke('google-calendar-oauth', {
      body: { action: 'start' },
    })
    if (error || data?.error || typeof data?.authorization_url !== 'string' || typeof data?.state !== 'string') {
      setCalendarError(error?.message ?? data?.error ??
        (appLocale === 'da-DK' ? 'Kunne ikke starte Google Kalender.' : 'Nem sikerült elindítani a Google Naptár kapcsolódását.'))
      setCalendarBusy(false)
      return
    }
    window.sessionStorage.setItem('penzfa-calendar-oauth-state', data.state)
    window.location.assign(data.authorization_url)
  }

  async function handleDisconnectCalendar() {
    if (!supabase || !session || calendarBusy) return
    const confirmed = window.confirm(appLocale === 'da-DK'
      ? 'Vil du fjerne forbindelsen til Google Kalender?'
      : 'Biztosan bontod a Google Naptár kapcsolatát?')
    if (!confirmed) return
    setCalendarBusy(true)
    setCalendarError(null)
    setCalendarNotice(null)
    const { data, error } = await supabase.functions.invoke('google-calendar-oauth', {
      body: { action: 'disconnect', confirmed: true },
    })
    setCalendarBusy(false)
    if (error || data?.error) {
      setCalendarError(error?.message ?? data?.error ?? 'A Google Naptár kapcsolat bontása nem sikerült.')
      return
    }
    setCalendarConnected(false)
    setCalendarAutoImportEnabled(false)
    setCalendarImportCandidates([])
    setCalendarChangeCandidates([])
    setCalendarAutoExportEnabled(false)
    setCalendarNeedsReauth(false)
    setCalendarNotice(appLocale === 'da-DK' ? 'Google Kalender er afbrudt.' : 'Google Naptár kapcsolat bontva.')
  }

  async function handleToggleCalendarAutoExport(enabled: boolean) {
    if (!supabase || !session || calendarBusy || !calendarConnected) return
    if (enabled && !window.confirm(appLocale === 'da-DK'
      ? 'Automatisk overførsel sender kun nye opgaver med dato, som tildeles dig, fra nu af. Aftaler med klokkeslæt varer 1 time. Vil du aktivere det?'
      : 'Az automatikus küldés a mostantól létrehozott, neked kijelölt, dátumos új ügyekre vonatkozik. Konkrét időpont esetén 1 órás esemény készül. Bekapcsolod?')) return

    setCalendarBusy(true)
    setCalendarError(null)
    setCalendarNotice(null)
    const { data, error } = await supabase.functions.invoke('google-calendar-oauth', {
      body: { action: 'set_auto_export', enabled, confirmed: enabled },
    })
    setCalendarBusy(false)
    if (error || data?.error || typeof data?.auto_export_enabled !== 'boolean') {
      setCalendarError(error?.message ?? data?.error ??
        (appLocale === 'da-DK' ? 'Kalender-indstillingen kunne ikke gemmes.' : 'Nem sikerült menteni az automatikus küldés beállítását.'))
      return
    }
    setCalendarAutoExportEnabled(data.auto_export_enabled)
    setCalendarNeedsReauth(false)
    setCalendarNotice(data.auto_export_enabled
      ? (appLocale === 'da-DK' ? 'Automatisk kalenderoverførsel er slået til for nye opgaver.' : 'Az automatikus küldés bekapcsolva az új ügyekhez.')
      : (appLocale === 'da-DK' ? 'Automatisk kalenderoverførsel er slået fra.' : 'Az automatikus küldés kikapcsolva.'))
  }

  async function reloadCalendarImports() {
    if (!supabase || !session) return
    setCalendarImportLoading(true)
    const { data, error } = await supabase.functions.invoke('google-calendar-oauth', {
      body: { action: 'list_calendar_imports' },
    })
    setCalendarImportLoading(false)
    if (error || data?.error) {
      setCalendarImportError(error?.message ?? data?.error ?? 'A Google Naptár-javaslatok nem tölthetők be.')
      return
    }
    setCalendarImportCandidates(Array.isArray(data?.items) ? data.items as CalendarImportCandidate[] : [])
    setCalendarImportError(null)
  }

  async function reloadCalendarChanges() {
    if (!supabase || !session) return
    const { data, error } = await supabase.functions.invoke('google-calendar-oauth', {
      body: { action: 'list_calendar_changes' },
    })
    if (error || data?.error) {
      setCalendarChangeError(appLocale === 'da-DK'
        ? 'Kunne ikke hente ændringer fra Google Kalender.'
        : 'Nem sikerült betölteni a Google Naptár módosításait.')
      return
    }
    setCalendarChangeCandidates(Array.isArray(data?.items) ? data.items as CalendarChangeCandidate[] : [])
    setCalendarChangeError(null)
  }

  async function handleDecideCalendarChange(candidate: CalendarChangeCandidate, decision: 'accept' | 'reject') {
    if (!supabase || !session || calendarChangeBusy) return
    const accept = decision === 'accept'
    // A módosításnál az azonosított esemény kártyáján lévő Igen/Nem
    // a megerősítés. Törlés átvételéhez külön, második jóváhagyás kell.
    if (candidate.change_type === 'delete' && accept && !window.confirm(
      appLocale === 'da-DK'
        ? 'Vil du også slette denne Google Kalender-aftale i assistenten: ' + (candidate.title ?? '') + '?'
        : 'Biztosan törlöd az asszisztensből is ezt a Google Naptár-eseményt: ' + (candidate.title ?? '') + '?'
    )) return
    setCalendarChangeBusy(true)
    setCalendarChangeError(null)
    const { data, error } = await supabase.functions.invoke('google-calendar-oauth', {
      body: { action: 'decide_calendar_change', change_id: candidate.id, decision, confirmed: true },
    })
    setCalendarChangeBusy(false)
    if (error || data?.error) {
      setCalendarChangeError(appLocale === 'da-DK'
        ? 'Ændringen kunne ikke behandles. Den oprindelige opgave er ikke overskrevet.'
        : 'A változtatást nem sikerült átvezetni. A meglévő ügyet nem írtuk felül.')
      await reloadCalendarChanges()
      return
    }
    setCalendarChangeCandidates(current => current.filter(row => row.event_id !== candidate.event_id))
    setCalendarChangeNotice(accept
      ? (candidate.change_type === 'delete'
        ? (appLocale === 'da-DK' ? 'Sletningen er overført til assistenten.' : 'A törlést átvettük az asszisztensbe.')
        : (appLocale === 'da-DK' ? 'Ændringen er overført til assistenten.' : 'A módosítást átvettük az asszisztensbe.'))
      : (appLocale === 'da-DK' ? 'Assistentens version er bevaret.' : 'Az asszisztens változata megmaradt.'))
  }

  useEffect(() => {
    if (!calendarChangeNotice) return
    const timer = window.setTimeout(() => setCalendarChangeNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [calendarChangeNotice])

  // A Google értesítésére kattintás nem csupán a kezdőlapot nyitja meg:
  // az adott javaslatot újra lekérjük, majd a döntéshez görgetünk.
  // Régi (?push=calendar-import) linkekre is működik.
  useEffect(() => {
    const captureIncomingCalendarLink = () => {
      const request = readCalendarPushRequest()
      if (request) setCalendarPushRequest(request)
    }
    window.addEventListener('pageshow', captureIncomingCalendarLink)
    window.addEventListener('focus', captureIncomingCalendarLink)
    document.addEventListener('visibilitychange', captureIncomingCalendarLink)
    return () => {
      window.removeEventListener('pageshow', captureIncomingCalendarLink)
      window.removeEventListener('focus', captureIncomingCalendarLink)
      document.removeEventListener('visibilitychange', captureIncomingCalendarLink)
    }
  }, [])

  useEffect(() => {
    if (!session || !familyName || !calendarPushRequest) return
    let cancelled = false
    const url = new URL(window.location.href)
    if (url.searchParams.get('push') === 'calendar-change' ||
        url.searchParams.get('push') === 'calendar-import') {
      url.searchParams.delete('push')
      url.searchParams.delete('change_id')
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    }
    setCalendarPushLoading(true)
    setCalendarPushLoaded(false)
    void Promise.all([reloadCalendarChanges(), reloadCalendarImports()]).finally(() => {
      if (cancelled) return
      setCalendarPushLoading(false)
      setCalendarPushLoaded(true)
    })
    return () => { cancelled = true }
  }, [session?.user.id, familyName, calendarPushRequest])

  useEffect(() => {
    if (!calendarPushRequest || !calendarPushLoaded || !calendarConnected) return
    const matchingChange = calendarPushRequest.changeId
      ? calendarChangeCandidates.find(candidate => candidate.id === calendarPushRequest.changeId)
      : calendarChangeCandidates[0]
    const target = matchingChange
      ? 'calendar-change-card-' + matchingChange.id
      : !calendarPushRequest.changeId && calendarImportCandidates.length
        ? 'calendar-import-inbox'
        : null
    if (!target) return
    const frame = window.requestAnimationFrame(() => {
      const element = document.getElementById(target)
      if (!element) return
      element.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setCalendarPushRequest(null)
      setCalendarPushLoaded(false)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [calendarPushRequest, calendarPushLoaded, calendarConnected,
      calendarChangeCandidates, calendarImportCandidates])

  // Mobilos push-megnyitáskor egy már futó PWA is visszatérhet előtérbe.
  // Ilyenkor újra lekérjük a függő Google Naptár-eseményeket, hogy a
  // jóváhagyási lehetőség kézi Frissítés nélkül is megjelenjen.
  useEffect(() => {
    if (!session || !familyName || !calendarConnected || !calendarAutoImportEnabled) return
    let lastRefresh = 0

    const refreshOnResume = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastRefresh < 2000) return
      lastRefresh = Date.now()
      void reloadCalendarImports()
      void reloadCalendarChanges()
    }

    document.addEventListener('visibilitychange', refreshOnResume)
    window.addEventListener('focus', refreshOnResume)
    const poll = window.setInterval(refreshOnResume, 60_000)
    return () => {
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', refreshOnResume)
      window.removeEventListener('focus', refreshOnResume)
    }
  }, [session?.user.id, familyName, calendarConnected, calendarAutoImportEnabled])

  async function handleToggleCalendarAutoImport(enabled: boolean) {
    if (!supabase || !session || calendarBusy || !calendarConnected) return
    if (enabled && !window.confirm(appLocale === 'da-DK'
      ? 'Vil du kontrollere nye Google Kalender-aftaler hvert 5. minut? Der sendes højst én push-besked pr. aftale, og du bestemmer altid, om den overføres til assistenten.'
      : 'Figyeljük ötpercenként az új Google Naptár-bejegyzéseket? Eseményenként legfeljebb egy push érkezik, és csak a jóváhagyásoddal kerülnek be az asszisztensbe.')) return
    setCalendarBusy(true)
    setCalendarError(null)
    setCalendarNotice(null)
    const { data, error } = await supabase.functions.invoke('google-calendar-oauth', {
      body: { action: 'set_auto_import', enabled, confirmed: enabled },
    })
    setCalendarBusy(false)
    if (error || data?.error || typeof data?.auto_import_enabled !== 'boolean') {
      setCalendarError(error?.message ?? data?.error ?? 'A Google Naptár figyelésének mentése nem sikerült.')
      return
    }
    setCalendarAutoImportEnabled(data.auto_import_enabled)
    setCalendarImportNeedsReauth(false)
    setCalendarNotice(data.auto_import_enabled
      ? (appLocale === 'da-DK' ? 'Nye Google Kalender-aftaler overvåges nu.' : 'Új Google Naptár-események figyelése bekapcsolva.')
      : (appLocale === 'da-DK' ? 'Kalenderovervågning slået fra.' : 'Google Naptár figyelése kikapcsolva.'))
    await reloadCalendarImports()
  }

  async function handleDecideCalendarImport(candidate: CalendarImportCandidate, decision: 'accept' | 'reject') {
    if (!supabase || !session || calendarImportBusy) return
    const yes = decision === 'accept'
    if (!window.confirm(yes
      ? (appLocale === 'da-DK'
        ? 'Overfør denne begivenhed til assistenten: ' + candidate.title + '?'
        : 'Biztosan átveszed az asszisztensbe ezt az eseményt: ' + candidate.title + '?')
      : (appLocale === 'da-DK'
        ? 'Afvis denne begivenhed permanent: ' + candidate.title + '?'
        : 'Biztosan elutasítod végleg ezt az eseményt: ' + candidate.title + '?'))) return
    setCalendarImportBusy(true)
    setCalendarImportError(null)
    setCalendarImportNotice(null)
    const { data, error } = await supabase.functions.invoke('google-calendar-oauth', {
      body: { action: 'decide_calendar_import', event_id: candidate.event_id, decision, confirmed: true },
    })
    setCalendarImportBusy(false)
    if (error || data?.error) {
      setCalendarImportError(error?.message ?? data?.error ?? 'A döntést nem sikerült menteni.')
      await reloadCalendarImports()
      return
    }
    setCalendarImportCandidates((current) => current.filter((item) => item.event_id !== candidate.event_id))
    setCalendarImportNotice(yes
      ? (appLocale === 'da-DK' ? 'Begivenheden er overført til assistenten.' : 'Az esemény bekerült az asszisztensbe.')
      : (appLocale === 'da-DK' ? 'Begivenheden afvist. Vi spørger ikke igen.' : 'Elutasítva. Erre az eseményre nem kérdezünk rá újra.'))
  }

  // A kézi Google Naptár-gomb csak a még nem küldött ügyekhez látszik.
  // A lista a felhasználó saját exportnaplójából, egyetlen kérésben készül.
  useEffect(() => {
    if (!supabase || !session || !calendarConnected || queryResults.length === 0) {
      setCalendarExportedItemIds(null)
      setCalendarExportStatusError(null)
      return
    }

    const itemIds = queryResults
      .filter((item) => item.status === 'open' && Boolean(item.due_date))
      .map((item) => item.id)
    if (itemIds.length === 0) {
      setCalendarExportedItemIds([])
      setCalendarExportStatusError(null)
      return
    }

    let cancelled = false
    let lastRefreshAt = 0
    setCalendarExportedItemIds(null)
    setCalendarExportStatusError(null)

    const refreshStatuses = async () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastRefreshAt < 2000) return
      lastRefreshAt = Date.now()

      const requests = []
      for (let offset = 0; offset < itemIds.length; offset += 100) {
        requests.push(supabase!.functions.invoke('google-calendar-oauth', {
          body: { action: 'list_calendar_export_statuses', item_ids: itemIds.slice(offset, offset + 100) },
        }))
      }
      const responses = await Promise.all(requests)
      if (cancelled) return

      if (responses.some(({ data, error }) => error || data?.error || !Array.isArray(data?.exported_item_ids))) {
        setCalendarExportedItemIds(null)
        setCalendarExportStatusError(appLocale === 'da-DK'
          ? 'Kalenderstatus kunne ikke kontrolleres. Søg igen for at prøve på ny.'
          : 'Nem sikerült ellenőrizni a naptárba küldést. Új lekérdezéssel próbálhatod újra.')
        return
      }

      setCalendarExportedItemIds(responses.flatMap(({ data }) => data.exported_item_ids as string[]))
      setCalendarExportStatusError(null)
    }

    const onResume = () => { void refreshStatuses() }
    void refreshStatuses()
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('focus', onResume)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onResume)
      window.removeEventListener('focus', onResume)
    }
  }, [session?.user.id, calendarConnected, queryResults, appLocale])

  async function handlePrepareCalendarExport(itemId: string) {
    if (!supabase || calendarExportBusy) return
    setCalendarExportBusy(true)
    setCalendarExportError(null)
    setCalendarExportFeedback(null)
    setCalendarExportDraft(null)
    const { data, error } = await supabase.functions.invoke('google-calendar-oauth', {
      body: { action: 'prepare_calendar_export', item_id: itemId },
    })
    setCalendarExportBusy(false)
    if (!error && (data?.status === 'already_exists' || data?.status === 'delivery_uncertain')) {
      setCalendarExportFeedback({
        kind: 'warning',
        message: data.status === 'already_exists'
          ? (appLocale === 'da-DK'
            ? 'Denne opgave blev allerede sendt til Google Kalender. Den sendes ikke igen, heller ikke efter sletning i kalenderen.'
            : 'Ezt az ügyet már kiküldtük a Google Naptárba. Nem küldjük újra akkor sem, ha a naptárból törölted.')
          : (appLocale === 'da-DK'
            ? 'En tidligere afsendelse har et usikkert resultat. Vi sender ikke automatisk igen.'
            : 'A korábbi küldés eredménye bizonytalan. A duplikáció elkerülésére nem küldjük újra.'),
      })
      return
    }
    if (error || data?.error || data?.status !== 'needs_confirmation' || !data?.draft) {
      setCalendarExportError(error?.message ?? data?.error ??
        (appLocale === 'da-DK' ? 'Kunne ikke forberede kalenderoverførslen.' : 'Nem sikerült előkészíteni a naptárba küldést.'))
      return
    }
    setCalendarExportDraft(data.draft as CalendarExportDraft)
  }

  async function handleConfirmCalendarExport() {
    if (!supabase || !calendarExportDraft || calendarExportBusy) return
    const draft = calendarExportDraft
    setCalendarExportBusy(true)
    setCalendarExportError(null)
    const { data, error } = await supabase.functions.invoke('google-calendar-oauth', {
      body: {
        action: 'confirm_calendar_export',
        item_id: draft.item_id,
        expected_updated_at: draft.expected_updated_at,
        confirmed: true,
        allow_resend: draft.resend === true,
      },
    })
    setCalendarExportBusy(false)
    if (!error && data?.status === 'still_exists') {
      setCalendarExportDraft(null)
      setCalendarExportFeedback({
        kind: 'warning',
        message: appLocale === 'da-DK'
          ? 'Begivenheden findes stadig i Google Kalender. Vi har ikke oprettet en kopi.'
          : 'Ellenőriztük: az esemény még szerepel a Google Naptárban. Nem hoztunk létre másolatot.',
      })
      return
    }
    if (!error && data?.status === 'delivery_uncertain') {
      setCalendarExportDraft(null)
      setCalendarExportFeedback({
        kind: 'warning',
        message: appLocale === 'da-DK'
          ? 'En tidligere afsendelse har et usikkert resultat. Vi sender ikke igen.'
          : 'A korábbi küldés eredménye bizonytalan. Nem küldjük újra automatikusan.',
      })
      return
    }
    if (error || data?.error || (data?.status !== 'exported' && data?.status !== 'already_exists')) {
      setCalendarExportError(error?.message ?? data?.error ??
        (appLocale === 'da-DK' ? 'Kunne ikke overføre kalenderaftalen.' : 'Nem sikerült elküldeni az eseményt a Google Naptárba.'))
      return
    }
    setCalendarExportDraft(null)
    setCalendarExportedItemIds((current) => current ? [...new Set([...current, draft.item_id])] : current)
    setCalendarExportFeedback({
      kind: data.status === 'already_exists' ? 'warning' : 'success',
      message: data.status === 'already_exists'
        ? (appLocale === 'da-DK' ? 'Denne opgave findes allerede i Google Kalender. Der blev ikke oprettet en kopi.' : 'Ez az esemény már szerepel a Google Naptárban. Nem hoztunk létre másolatot.')
        : (appLocale === 'da-DK' ? 'Begivenheden er tilføjet til Google Kalender.' : 'Az esemény bekerült a Google Naptárba.'),
    })
  }

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
    // A magyar felület már magyar választ kap a Core-tól: nincs mit AI-val fordítani.
    if (appLocale !== 'da-DK') return result
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
    // A callbackban is biztosan nem-null Supabase kliensre hivatkozunk.
    const activeSupabase = supabase

    setVoiceTranscribing(true)
    setVoiceError(null)

    try {
      const extension = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm'
      const form = new FormData()
      // A codecs paramétert a WebM fájlnál a transzkripciós API nem mindig fogadja el.
      const uploadType = mimeType.split(';')[0].trim() || 'audio/webm'
      form.append('file', new File([audio], `penzfa-voice.${extension}`, { type: uploadType }))
      form.append('language', appLocale === 'da-DK' ? 'da' : 'hu')
      form.append(
        'member_names',
        familyMembers.map((member) => member.display_name).join(', '),
      )

      const invokeTranscription = () => activeSupabase.functions.invoke('transcribe-audio', {
        body: form,
      })

      let { data, error } = await invokeTranscription()

      if (error) {
        const response = (error as { context?: unknown }).context
        const status = response instanceof Response ? response.status : null

        if (status === 401) {
          await activeSupabase.auth.refreshSession()
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

  // A Supabase FunctionsHttpError alapértelmezett szövege technikai.
  // A Core által visszaadott rövid, felhasználónak szóló hibát mutatjuk.
  async function describeCoreFailure(error: unknown): Promise<string> {
    const context = (error as { context?: unknown } | null)?.context
    if (context instanceof Response) {
      try {
        const payload = await context.clone().json() as { error?: unknown }
        if (typeof payload?.error === 'string' && payload.error.trim()) {
          return appLocale === 'da-DK'
            ? 'Sprogforståelsen mislykkedes. Prøv venligst igen.'
            : payload.error
        }
      } catch {
        // A hálózati válasz sérült vagy üres: magyar/dán alapüzenet.
      }
    }
    return appLocale === 'da-DK'
      ? 'Sprogforståelsen mislykkedes. Prøv venligst igen.'
      : 'A nyelvi feldolgozás most nem sikerült. Próbáld meg újra.'
  }

  async function handleMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return

    const message = createMessage.trim()
    if (!message) return
    setCalendarExportDraft(null)
    setCalendarExportFeedback(null)
    setCalendarExportError(null)


    if (noteEditTarget) {
      if (message.length > 1000) {
        setCreateError(appLocale === 'da-DK'
          ? 'En note må højst være 1000 tegn.'
          : 'Egy megjegyzés legfeljebb 1000 karakter lehet.')
        return
      }
      setCreateBusy(true)
      setCreateError(null)
      setCreateSuccess(null)
      setVoiceError(null)

      const { data, error } = await invokeLocalizedCore({
        body: {
          action: 'prepare_update_target',
          target_item_id: noteEditTarget.id,
          changes: { notes_append: message },
        },
      })

      if (error || data?.status !== 'needs_confirmation'
        || !data?.draft?.pending_action_id || data.draft.target_item_id !== noteEditTarget.id) {
        setCreateBusy(false)
        setCreateError(error?.message ?? data?.error ??
          (appLocale === 'da-DK' ? 'Kunne ikke forberede noten.' : 'A megjegyzést nem sikerült előkészíteni.'))
        return
      }

      // A felhasználó már a konkrét ügyet választotta ki és a Küldés gombra kattintott.
      // A szerver meglévő jogosultság- és hosszellenőrzése után ugyanabban
      // a folyamatban mentjük a megjegyzést, további megerősítő gomb nélkül.
      const { data: saved, error: saveError } = await invokeLocalizedCore({
        body: {
          action: 'confirm_update',
          pending_action_id: data.draft.pending_action_id,
        },
      })

      setCreateBusy(false)
      if (saveError || saved?.status !== 'updated' || saved?.item?.id !== noteEditTarget.id) {
        setCreateError(saveError?.message ?? saved?.error ??
          (appLocale === 'da-DK' ? 'Kunne ikke gemme noten.' : 'Nem sikerült menteni a megjegyzést.'))
        return
      }

      setCreateMessage('')
      setNoteEditTarget(null)
      setUpdateDraft(null)
      setAssistantAnswer(null)
      setCreateSuccess(appLocale === 'da-DK'
        ? `Note tilføjet: ${saved.item.title ?? noteEditTarget.title}`
        : `Megjegyzés hozzáadva: ${saved.item.title ?? noteEditTarget.title}`)
      return
    }

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

      if (error || data?.status !== 'needs_confirmation'
        || !data?.draft?.pending_action_id || data.draft.target_item_id !== dateEditTarget.id) {
        setCreateBusy(false)
        setCreateError(error?.message ?? data?.error ?? 'A módosítást nem sikerült előkészíteni.')
        return
      }

      // Kiválasztott ügy + egyértelműen értelmezett időpont: a felhasználó
      // Küldés gombja elegendő, a szerver eredeti ellenőrzéseit megtartjuk.
      const { data: saved, error: saveError } = await invokeLocalizedCore({
        body: {
          action: 'confirm_update',
          pending_action_id: data.draft.pending_action_id,
        },
      })

      setCreateBusy(false)
      if (saveError || saved?.status !== 'updated' || saved?.item?.id !== dateEditTarget.id) {
        setCreateError(saveError?.message ?? saved?.error ?? 'Nem sikerült menteni az új időpontot.')
        return
      }

      setCreateMessage('')
      setUpdateDraft(null)
      setDateEditTarget(null)
      setAssistantAnswer(null)
      setCreateSuccess((appLocale === 'da-DK' ? 'Tidspunkt ændret: ' : 'Dátum/időpont módosítva: ')
        + (saved.item.title ?? dateEditTarget.title))
      const review = saved.reminder_review as { reminder_at: string | null } | null
      if (review) {
        setReminderFollowUp({
          id: String(saved.item.id),
          title: String(saved.item.title),
          due_date: saved.item.due_date ?? null,
          due_time: saved.item.due_time ?? null,
          reminder_at: review.reminder_at,
        })
      } else {
        setReminderFollowUp(null)
      }
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

      if (error) {
        setCreateBusy(false)
        setCreateError(error.message)
        return
      }

      if (data?.status === 'reminder_needs_clarification') {
        setCreateBusy(false)
        setCreateError(data.error ?? 'Az emlékeztetés időpontját még pontosítani kell.')
        return
      }

      if (data?.status !== 'needs_confirmation'
        || !data?.draft?.pending_action_id || data.draft.target_item_id !== reminderEditTarget.id) {
        setCreateBusy(false)
        setCreateError(data?.error ?? 'Az emlékeztetést nem sikerült előkészíteni.')
        return
      }

      const { data: saved, error: saveError } = await invokeLocalizedCore({
        body: {
          action: 'confirm_reminder_update',
          pending_action_id: data.draft.pending_action_id,
        },
      })

      setCreateBusy(false)
      if (saveError || saved?.status !== 'reminder_updated' || saved?.item?.id !== reminderEditTarget.id) {
        setCreateError(saveError?.message ?? saved?.error ?? 'Az emlékeztetést most nem sikerült módosítani.')
        return
      }

      setCreateMessage('')
      setReminderUpdateDraft(null)
      setReminderEditTarget(null)
      setAssistantAnswer(null)
      setCreateSuccess((appLocale === 'da-DK' ? 'Påmindelse ændret: ' : 'Emlékeztető módosítva: ')
        + (saved.item.title ?? reminderEditTarget.title))
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
    setNoteEditTarget(null)
    setReminderFollowUp(null)
    setDeleteDraft(null)
    setDeleteCandidates([])
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
      setCreateError(await describeCoreFailure(intentError))
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

      if (data?.status === 'choose_target' && Array.isArray(data.candidates)) {
        setDeleteCandidates(data.candidates as DeleteCandidate[])
        setAssistantAnswer(appLocale === 'da-DK'
          ? 'Flere opgaver passer. Vælg den, du vil slette, og bekræft derefter.'
          : 'Több megfelelő ügyet találtam. Válaszd ki, melyiket töröljük, majd erősítsd meg.')
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
      setCreateError(await describeCoreFailure(error))
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

  async function handlePrepareDeleteCandidate(candidate: Pick<DeleteCandidate, 'id' | 'title'>) {
    if (!supabase || createBusy) return
    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)
    try {
      const { data, error } = await invokeLocalizedCore({
        body: { action: 'prepare_delete_target', target_item_id: candidate.id },
      })
      if (error || data?.status !== 'needs_confirmation'
        || !data.draft?.pending_action_id || data.draft.target_item_id !== candidate.id) {
        setCreateError(error?.message ?? data?.error ?? (appLocale === 'da-DK'
          ? 'Den valgte opgave kan ikke slettes.'
          : 'Nem sikerült előkészíteni a kiválasztott ügy törlését.'))
        return
      }
      setDeleteDraft(data.draft as DeleteDraft)
      setDeleteCandidates([])
      setQueryResults([])
      setAssistantAnswer(null)
      setCreateMessage('')
    } catch {
      setCreateError(appLocale === 'da-DK'
        ? 'Opgaven kunne ikke vælges til sletning.'
        : 'Nem sikerült kiválasztani a törlendő ügyet.')
    } finally {
      setCreateBusy(false)
    }
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
      setDeleteCandidates([])
      setQueryResults([])
      setAssistantAnswer(null)
      if (calendarConnected && data.item?.id) {
        const { data: linked } = await supabase.functions.invoke('google-calendar-oauth', {
          body: { action: 'get_linked_calendar_item', item_id: data.item.id },
        })
        if (linked?.linked) {
          setCalendarDeleteFollowUp({
            id: String(data.item.id), title: String(data.item.title ?? 'Esemény'),
          })
        }
      }
      return
    }

    setCreateError(data?.error ?? 'Az ügyet most nem sikerült törölni.')
  }

  async function handleDeleteLinkedGoogleEvent() {
    if (!supabase || !session || !calendarDeleteFollowUp || calendarDeleteBusy) return
    if (!window.confirm(appLocale === 'da-DK'
      ? 'Vil du også slette denne begivenhed permanent i Google Kalender: ' + calendarDeleteFollowUp.title + '?'
      : 'Biztosan törlöd a Google Naptárból is ezt az eseményt: ' + calendarDeleteFollowUp.title + '?')) return
    setCalendarDeleteBusy(true)
    setCalendarDeleteError(null)
    const {data,error}=await supabase.functions.invoke('google-calendar-oauth',{
      body:{action:'delete_linked_calendar_event',item_id:calendarDeleteFollowUp.id,confirmed:true},
    })
    setCalendarDeleteBusy(false)
    if (error || data?.error || data?.status!=='deleted') {
      setCalendarDeleteError(appLocale === 'da-DK'
        ? 'Google Kalender kunne ikke slette aftalen. Kontrollér kalenderen, før du prøver igen.'
        : 'A Google Naptárban nem sikerült igazolni a törlést. Ellenőrizd a naptárat újrapróbálás előtt.')
      return
    }
    setCreateSuccess(appLocale === 'da-DK'
      ? 'Begivenheden er slettet i Google Kalender og assistenten.'
      : 'Az eseményt az asszisztensből és a Google Naptárból is töröltük.')
    setCalendarDeleteFollowUp(null)
  }

  function startReminderEdit(itemId: string, title: string,
    dueDate: string | null = null, dueTime: string | null = null,
    reminderAt: string | null = null,
  ) {
    setReminderFollowUp(null)
    setDateEditTarget(null)
    setNoteEditTarget(null)
    setReminderEditTarget({ id: itemId, title, due_date: dueDate, due_time: dueTime, reminder_at: reminderAt })
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
    setAssistantAnswer(null)
  }


  function startDateEdit(itemId: string, title: string,
    dueDate: string | null, dueTime: string | null,
  ) {
    setReminderFollowUp(null)
    setNoteEditTarget(null)
    setDateEditTarget({ id: itemId, title, due_date: dueDate, due_time: dueTime })
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
    setAssistantAnswer(null)
  }

  function startNoteEdit(itemId: string, title: string, dueDate: string | null, dueTime: string | null) {
    setReminderFollowUp(null)
    setNoteEditTarget({ id: itemId, title, due_date: dueDate, due_time: dueTime })
    setDateEditTarget(null)
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
    setAssistantAnswer(null)
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
    setReminderEditTarget({ ...target, due_date: target.due_date ?? null, due_time: target.due_time ?? null })
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
      setNoteEditTarget(null)
      const review = data.reminder_review as { reminder_at: string | null } | null
      if (review && data.item?.id) {
        setReminderFollowUp({
          id: String(data.item.id),
          title: String(data.item.title),
          due_date: data.item.due_date ?? null,
          due_time: data.item.due_time ?? null,
          reminder_at: review.reminder_at,
        })
      } else {
        setReminderFollowUp(null)
      }
      return
    }

    setCreateError(data?.error ?? 'Az ügyet most nem sikerült módosítani.')
  }

  function finishCompletedItem(title: string, partnerWarning?: string | null) {
    // After completing an item, leave the old search/confirmation context
    // entirely. Otherwise another tap targets an item that is no longer open.
    setCreateMessage('')
    setCreateDraft(null)
    setCompleteDraft(null)
    setCompleteCandidates([])
    setQueryResults([])
    setAssistantAnswer(null)
    setUpdateDraft(null)
    setReminderUpdateDraft(null)
    setReminderEditTarget(null)
    setDateEditTarget(null)
    setNoteEditTarget(null)
    setReminderFollowUp(null)
    setDeleteDraft(null)
    setDeleteCandidates([])
    setCalendarExportDraft(null)
    setCalendarExportFeedback(null)
    setCalendarExportError(null)
    setCreateError(null)
    setVoiceError(null)
    setPushContext(null)
    setLocalizedPush(null)
    setCreateSuccess(
      (appLocale === 'da-DK' ? 'Markeret som udført: ' : 'Sikeresen készre jelölve: ')
      + title + (partnerWarning ? ' – ' + partnerWarning : ''),
    )
    window.requestAnimationFrame(() => {
      document.querySelector('.capture-primary')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    })
  }

  async function handleCompleteCandidate(candidate: Pick<CompleteCandidate, 'id' | 'title'>) {
    if (!supabase || createBusy || completionRequestRef.current) return
    completionRequestRef.current = true
    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)

    try {
      const { data: prepared, error: prepareError } = await invokeLocalizedCore({
        body: {
          action: 'prepare_complete_target',
          target_item_id: candidate.id,
        },
      })

      if (prepareError) {
        setCreateError(prepareError.message)
        return
      }

      if (prepared?.status === 'future_event_needs_date') {
        setAssistantAnswer(
          prepared.prompt ?? 'Ez az esemény még jövőbeli. Írd meg, mikor történt meg valójában.',
        )
        return
      }

      if (prepared?.status !== 'needs_confirmation' || !prepared?.draft?.pending_action_id
        || prepared.draft.target_item_id !== candidate.id) {
        setCreateError(prepared?.error ?? (appLocale === 'da-DK'
          ? 'Den valgte opgave kunne ikke forberedes.'
          : 'A kiválasztott ügyet most nem sikerült előkészíteni.'))
        return
      }

      const { data, error } = await invokeLocalizedCore({
        body: {
          action: 'confirm_complete',
          pending_action_id: prepared.draft.pending_action_id,
        },
      })

      if (error) {
        setCreateError(error.message)
        return
      }

      if (data?.status === 'completed' && data.item?.id === candidate.id) {
        finishCompletedItem(
          String(data.item.title ?? candidate.title),
          data.partner_notification_warning ?? null,
        )
        return
      }

      setCreateError(data?.error ?? (appLocale === 'da-DK'
        ? 'Opgaven kunne ikke markeres som udført.'
        : 'Az ügyet most nem sikerült készre jelölni.'))
    } catch {
      setCreateError(appLocale === 'da-DK'
        ? 'Det lykkedes ikke at gemme opgavens status.'
        : 'A készre jelölést most nem sikerült elmenteni.')
    } finally {
      completionRequestRef.current = false
      setCreateBusy(false)
    }
  }

  async function handleConfirmComplete() {
    if (!supabase || !completeDraft || createBusy || completionRequestRef.current) return
    completionRequestRef.current = true
    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)

    try {
      const { data, error } = await invokeLocalizedCore({
        body: {
          action: 'confirm_complete',
          pending_action_id: completeDraft.pending_action_id,
        },
      })

      if (error) {
        setCreateError(error.message)
        return
      }

      if (data?.status === 'completed') {
        finishCompletedItem(
          String(data.item?.title ?? (appLocale === 'da-DK' ? 'opgave' : 'ügy')),
          data.partner_notification_warning ?? null,
        )
        return
      }

      setCreateError(data?.error ?? (appLocale === 'da-DK'
        ? 'Opgaven kunne ikke markeres som udført.'
        : 'Az ügyet most nem sikerült készre jelölni.'))
    } catch {
      setCreateError(appLocale === 'da-DK'
        ? 'Det lykkedes ikke at gemme opgavens status.'
        : 'A készre jelölést most nem sikerült elmenteni.')
    } finally {
      completionRequestRef.current = false
      setCreateBusy(false)
    }
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
    setNoteEditTarget(null)
    setReminderFollowUp(null)
    setDeleteDraft(null)
    setDeleteCandidates([])
    setCalendarExportDraft(null)
    setCalendarExportError(null)
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
    const selectedEditTarget = noteEditTarget ?? dateEditTarget ?? reminderEditTarget
    const hasCalendarPushTarget = calendarPushRequest?.changeId
      ? calendarChangeCandidates.some(candidate => candidate.id === calendarPushRequest.changeId)
      : calendarChangeCandidates.length > 0 || calendarImportCandidates.length > 0
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
                <summary>Első lépések</summary>
                <p>
                  Írd be vagy diktáld természetesen, mit kell elintézni.
                  Lehetőleg mondd el, mi a teendő, mikor esedékes, és ki intézi.
                </p>
                <p><strong>Példa:</strong> „Holnap 10-kor hívjam fel a könyvelőt.”</p>
                <p>Mentés és módosítás előtt ellenőrizd a felismert adatokat.</p>
              </details>

              <details className="help-section" open>
                <summary>Az 5 alapművelet</summary>
                <ol>
                  <li><strong>Rögzítés:</strong> új feladat, esemény vagy határidő felvétele.</li>
                  <li><strong>Keresés:</strong> „Mik a nyitott feladataim?”</li>
                  <li><strong>Módosítás:</strong> dátum, időpont, emlékeztető vagy megjegyzés hozzáadása.</li>
                  <li><strong>Készre jelölés:</strong> „A könyvelőt felhívtam.”</li>
                  <li><strong>Törlés:</strong> „Töröld a pénteki fodrászt.”</li>
                </ol>
                <p>Bizonytalan ügyválasztásnál pontosítást kérünk. A kiválasztott ügy dátuma, emlékeztetője és megjegyzése egy Küldés gombbal menthető. A készre jelölést és a törlést külön meg kell erősíteni.</p>
                <p>A korábbi ügyekre is kereshetsz, például „Milyen eseményeim voltak tegnap?” vagy „Mutasd a tegnapi lezárt ügyeket.” A már elvégzett események is törölhetők az asszisztensből, de előtte mindig kiválasztást és jóváhagyást kérünk. A Google Naptárból csak külön döntés után törlünk.</p>
              </details>

              <details className="help-section" open>
                <summary>Megjegyzések</summary>
                <p>
                  Már az új ügy rögzítésekor is adhatsz megjegyzést:
                  „Szombaton buli Petiéknél, megjegyzés: süteményt kell vinni.”
                </p>
                <p>
                  Meglévő ügyhöz keress rá a feladatra, válaszd a
                  <strong> „Megjegyzés hozzáírása”</strong> gombot, majd írd vagy mondd be
                  az új szöveget, és nyomd meg a Küldés gombot.
                </p>
                <p>A korábbi megjegyzések megmaradnak, és a találatoknál is láthatók.</p>
              </details>

              <details className="help-section">
                <summary>Emlékeztetők, briefing és naptár</summary>
                <p>
                  Emlékeztetőt rögzítéskor vagy később is kérhetsz:
                  „Szólj egy órával előtte.”
                </p>
                <p>
                  A reggeli briefing bekapcsolását és idejét a Beállításokban adhatod meg.
                  Az értesítéseket minden eszközön külön engedélyezd a Fiók és értesítések résznél.
                  A lejárt, nyitott ügyeket a lejárat utáni első két napon még jelzi,
                  utána a briefingből kihagyja, de az ügy továbbra is nyitott és kereshető.
                  Ha egy ügyhöz nem kértél külön emlékeztetőt, emiatt nem küldünk
                  ismétlődő figyelmeztetést a briefingben.
                </p>
                <p>
                  A Google Naptárat a Beállításokban kapcsolhatod össze. Az új, dátumos
                  ügyeket kézzel, vagy a külön bekapcsolható automatikus küldéssel viheted
                  át. Időponttal alapból egyórás, anélkül egész napos esemény készül.
                  Az automatikus új eseményküldés csak a bekapcsolás után létrehozott,
                  neked kijelölt ügyekre vonatkozik.
                </p>
                <p>
                  A már összekapcsolt esemény dátumának, időpontjának és megjegyzésének
                  asszisztensbeli módosítása a Google Naptárba is átkerül, rendszerint
                  az ötpercenkénti ellenőrzéskor. Nem készül második esemény.
                  A Google Naptárban végzett módosítás vagy törlés külön
                  jóváhagyási javaslatként jelenik meg az asszisztensben;
                  jóváhagyás nélkül nem írjuk át a meglévő ügyet.
                </p>
                <p>
                  Készre jelöléskor a Google-esemény megmarad, leírása végére
                  „Elvégezve” (dán nyelvű beállításnál „Udført”) kerül.
                  Az asszisztensbeli törlés nem töröl automatikusan a Google Naptárban:
                  a Google-beli törléshez külön megerősítés kell.
                  Ha a két helyen időközben egymástól eltérő módosítás történt,
                  nem írjuk felül csendben a másikat; a helyzetet egyeztetni kell.
                </p>
                <p>
                  A Google Naptár új eseményeinek figyelését külön kapcsolhatod be.
                  Minden új bejegyzésre legfeljebb egy push érkezik; az átvételt
                  külön jóvá kell hagyni. Válasz nélkül a következő reggeli
                  briefingben egyszer jelezzük, majd a javaslat lejár.
                </p>
              </details>

              <details className="help-section">
                <summary>Családtagok és telepítés</summary>
                <p>
                  A Családtagok résznél felvehetsz saját fiók nélküli családtagokat,
                  és meghívhatsz egy másik családi felhasználót. Egy családhoz
                  legfeljebb két belépő felhasználó tartozhat.
                </p>
                <p>Az alkalmazást a Telepítés a telefonra résznél teheted a kezdőképernyőre.</p>
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
                  onClick={() => {
                    if (pushContext.type === 'briefing' && session) {
                      const date = pushContext.briefing_date
                        ?? currentDateAndTimeInZone(settings.timezone || 'Europe/Budapest').date
                      window.localStorage.setItem(
                        `penzfa-briefing-dismissed:${session.user.id}:${date}`,
                        '1',
                      )
                    }
                    setPushContext(null)
                  }}
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

          {familyName && calendarConnected && calendarImportNotice && (
            <p className="notice success" role="status">{calendarImportNotice}</p>
          )}
          {familyName && calendarPushRequest && (
            <section className="capture-block calendar-import-inbox" aria-label={
              appLocale === 'da-DK' ? 'Åbn Google Kalender-besked' : 'Megnyitott Google Naptár-értesítés'
            }>
              <h2>{appLocale === 'da-DK'
                ? 'Google Kalender – beslutning'
                : 'Google Naptár – döntésre váró módosítás'}</h2>
              {calendarPushLoading || !calendarPushLoaded ? (
                <p role="status">{appLocale === 'da-DK'
                  ? 'Henter ændringen…' : 'A módosítás betöltése…'}</p>
              ) : hasCalendarPushTarget ? (
                <p role="status">{appLocale === 'da-DK'
                  ? 'Åbn godkendelsesfeltet nedenfor for at vælge Ja eller Nej.'
                  : 'Az alábbi eseménynél választhatsz: átveszed vagy elutasítod a módosítást.'}</p>
              ) : (
                <>
                  <p role="alert">{appLocale === 'da-DK'
                    ? 'Ændringen blev ikke fundet. Der er ikke overført noget automatisk. Prøv at hente forslagene igen.'
                    : 'A hivatkozott módosítást most nem sikerült megjeleníteni. Nem vettünk át semmit automatikusan.'}</p>
                  <button type="button" className="secondary-button"
                    onClick={() => setCalendarPushRequest(current => current ? { ...current } : null)}>
                    {appLocale === 'da-DK' ? 'Hent igen' : 'Újrapróbálás'}
                  </button>
                </>
              )}
            </section>
          )}

          {familyName && calendarConnected && calendarChangeNotice && (
            <p className="notice success" role="status">{calendarChangeNotice}</p>
          )}
          {familyName && calendarConnected && (calendarChangeCandidates.length > 0 || Boolean(calendarChangeError)) && (
            <section id="calendar-changes-inbox" className="capture-block calendar-import-inbox"
              aria-label={appLocale === 'da-DK' ? 'Ændringer i Google Kalender' : 'Google Naptár – módosítások'}>
              <h2>{appLocale === 'da-DK'
                ? 'Ændringer fra Google Kalender – afventer din beslutning'
                : 'Google Naptár-változások – döntésre várnak'}</h2>
              {calendarChangeError && (
                <>
                  <p className="notice error" role="alert">{calendarChangeError}</p>
                  <button className="secondary-button" type="button"
                    onClick={() => void reloadCalendarChanges()} disabled={calendarChangeBusy}>
                    {appLocale === 'da-DK' ? 'Prøv igen' : 'Újrapróbálás'}
                  </button>
                </>
              )}
              {calendarChangeCandidates.map(candidate => (
                <div className="confirmation-card" key={candidate.id}
                  id={'calendar-change-card-' + candidate.id}>
                  <strong>{candidate.title ?? candidate.event_id}</strong>
                  {candidate.change_type === 'delete' ? (
                    <p>{appLocale === 'da-DK'
                      ? 'Denne aftale er slettet i Google Kalender. Vil du også slette den i assistenten?'
                      : 'Ezt az eseményt törölték a Google Naptárban. Átveszed a törlést az asszisztensbe?'}</p>
                  ) : (
                    <>
                      {candidate.local_item?.due_date && (
                        <p><strong>{appLocale === 'da-DK'
                          ? 'Nuværende tidspunkt i assistenten: '
                          : 'Jelenleg az asszisztensben: '}</strong>
                          {new Date(candidate.local_item.due_date + 'T12:00:00')
                            .toLocaleDateString(appLocale === 'da-DK' ? 'da-DK' : 'hu-HU', { dateStyle: 'long' })}
                          {candidate.local_item.due_time
                            ? ' ' + candidate.local_item.due_time.slice(0, 5) : ''}
                        </p>
                      )}
                      <p><strong>{appLocale === 'da-DK'
                        ? 'Nyt tidspunkt i Google Kalender: '
                        : 'Új időpont a Google Naptárban: '}</strong>
                        {candidate.due_date ? new Date(candidate.due_date + 'T12:00:00')
                          .toLocaleDateString(appLocale === 'da-DK' ? 'da-DK' : 'hu-HU', { dateStyle: 'long' }) : ''}
                        {candidate.due_time ? ' ' + candidate.due_time.slice(0, 5) : ''}
                      </p>
                      {candidate.notes && (
                        <p className="confirmation-hint" style={{whiteSpace:'pre-wrap'}}>
                          <strong>{appLocale === 'da-DK' ? 'Note:' : 'Megjegyzés:'}</strong> {candidate.notes}
                        </p>
                      )}
                    </>
                  )}
                  <div className="confirmation-actions">
                    <button className="primary-button" type="button" disabled={calendarChangeBusy}
                      onClick={() => void handleDecideCalendarChange(candidate, 'accept')}>
                      {candidate.change_type === 'delete'
                        ? (appLocale === 'da-DK' ? 'Overfør sletning' : 'Törlés átvétele')
                        : (appLocale === 'da-DK' ? 'Ja, overtag ændringen' : 'Igen, átveszem')}
                    </button>
                    <button className="secondary-button" type="button" disabled={calendarChangeBusy}
                      onClick={() => void handleDecideCalendarChange(candidate, 'reject')}>
                      {candidate.change_type === 'update'
                        ? (appLocale === 'da-DK' ? 'Nej, behold den tidligere tid' : 'Nem, maradjon a korábbi időpont')
                        : (appLocale === 'da-DK' ? 'Behold i assistenten' : 'Megtartom az asszisztensben')}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {familyName && calendarConnected && (calendarImportCandidates.length > 0 || Boolean(calendarImportError)) && (
            <section id="calendar-import-inbox" className="capture-block calendar-import-inbox" aria-label={appLocale === 'da-DK' ? 'Google Kalender – forslag' : 'Google Naptár – átvételi javaslatok'}>
              {calendarImportCandidates.length > 0 && (
                <h2>{appLocale === 'da-DK' ? 'Nye begivenheder fra Google Kalender' : 'Új események a Google Naptárból'}</h2>
              )}
              {calendarImportError && (
                <>
                  <p className="notice error" role="alert">{calendarImportError}</p>
                  <button className="secondary-button" type="button" disabled={calendarImportLoading || calendarImportBusy}
                    onClick={() => void reloadCalendarImports()}>
                    {calendarImportLoading ? t('loading') : (appLocale === 'da-DK' ? 'Prøv igen' : 'Újrapróbálás')}
                  </button>
                </>
              )}
              {calendarImportCandidates.map((candidate) => (
                <div className="confirmation-card" key={candidate.event_id}>
                  <strong>{candidate.title}</strong>
                  <p>{new Date(candidate.due_date + 'T12:00:00').toLocaleDateString(
                    appLocale === 'da-DK' ? 'da-DK' : 'hu-HU', { dateStyle: 'long' })}
                    {candidate.due_time ? ' – ' + candidate.due_time.slice(0, 5)
                      : (appLocale === 'da-DK' ? ' (hele dagen)' : ' (egész napos)')}</p>
                  {candidate.notes && <p className="confirmation-hint" style={{whiteSpace:'pre-wrap'}}>
                    <strong>{appLocale === 'da-DK' ? 'Note:' : 'Megjegyzés:'}</strong> {candidate.notes}
                  </p>}
                  <p className="settings-hint">{appLocale === 'da-DK' ? 'Kan godkendes indtil: ' : 'Döntési határidő: '}
                    {new Date(candidate.expires_at).toLocaleString(appLocale === 'da-DK' ? 'da-DK' : 'hu-HU',
                      {dateStyle:'medium',timeStyle:'short'})}</p>
                  <div className="confirmation-actions">
                    <button type="button" className="primary-button" disabled={calendarImportBusy}
                      onClick={() => void handleDecideCalendarImport(candidate, 'accept')}>
                      {appLocale === 'da-DK' ? 'Overfør' : 'Átveszem'}
                    </button>
                    <button type="button" className="secondary-button" disabled={calendarImportBusy}
                      onClick={() => void handleDecideCalendarImport(candidate, 'reject')}>
                      {appLocale === 'da-DK' ? 'Afvis' : 'Nem kérem'}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {familyName && (
            <section className="capture-block capture-primary" aria-label={tr("Kommunikáció")}>
              {createSuccess && <p className="notice success" role="status">{createSuccess}</p>}
              <h2>{noteEditTarget
                ? (appLocale === 'da-DK' ? 'Tilføj note' : 'Megjegyzés hozzáírása')
                : dateEditTarget
                  ? (appLocale === 'da-DK' ? 'Rediger dato/tid' : 'Dátum/időpont módosítása')
                  : reminderEditTarget
                    ? (appLocale === 'da-DK' ? 'Rediger påmindelse' : 'Emlékeztető módosítása')
                    : t('captureHeading')}</h2>
              {selectedEditTarget ? (
                <div className="note-edit-context" role="group" aria-label={appLocale === 'da-DK' ? 'Opgave, der redigeres' : 'Módosított ügy'}>
                  <span className="note-edit-context-caption">
                    {noteEditTarget
                      ? (appLocale === 'da-DK' ? 'Du tilføjer en note til:' : 'Ehhez az ügyhöz írsz megjegyzést:')
                      : dateEditTarget
                        ? (appLocale === 'da-DK' ? 'Du ændrer tidspunktet for:' : 'Ennek az ügynek módosítod az időpontját:')
                        : (appLocale === 'da-DK' ? 'Du ændrer påmindelsen for:' : 'Ennek az ügynek módosítod az emlékeztetőjét:')}
                  </span>
                  <strong className="note-edit-context-title">{selectedEditTarget.title}</strong>
                  <span className="note-edit-context-date">
                    {selectedEditTarget.due_date
                      ? new Date(selectedEditTarget.due_date + 'T12:00:00').toLocaleDateString(
                        appLocale === 'da-DK' ? 'da-DK' : 'hu-HU', { dateStyle: 'long' },
                      ) + (selectedEditTarget.due_time ? ' – ' + selectedEditTarget.due_time.slice(0, 5) : '')
                      : (appLocale === 'da-DK' ? 'Dato ikke angivet' : 'Nincs megadott dátum')}
                  </span>
                  {reminderEditTarget && (
                    <span className="note-edit-context-date">
                      {appLocale === 'da-DK' ? 'Nuværende påmindelse: ' : 'Jelenlegi emlékeztető: '}
                      {reminderEditTarget.reminder_at
                        ? new Date(reminderEditTarget.reminder_at).toLocaleString(
                          appLocale === 'da-DK' ? 'da-DK' : 'hu-HU',
                          { dateStyle: 'long', timeStyle: 'short' },
                        )
                        : (appLocale === 'da-DK' ? 'Ingen indstillet eller ukendt' : 'Nincs beállítva vagy nem ismert')}
                    </span>
                  )}
                  <p className="note-edit-context-hint">
                    {noteEditTarget
                      ? (appLocale === 'da-DK' ? 'Skriv eller indtal notens tekst nedenfor.' : 'Írd vagy diktáld a megjegyzés szövegét az alábbi mezőbe.')
                      : dateEditTarget
                        ? (appLocale === 'da-DK' ? 'Angiv den nye dato eller tid, fx i morgen kl. 14:30. Afsend gemmer ændringen.' : 'Add meg az új dátumot vagy időpontot, például: holnap 14:30. A Küldés elmenti a módosítást.')
                        : (appLocale === 'da-DK'
                          ? 'Angiv den nye påmindelse, fx en halv time før eller ingen påmindelse. Afsend gemmer ændringen.'
                          : 'Add meg az új emlékeztetőt, például: előtte fél órával, aznap 18:00-kor, vagy nem kérek emlékeztetőt. A Küldés elmenti a módosítást.')}
                  </p>
                  {!updateDraft && !reminderUpdateDraft && (
                    <button className="secondary-button note-edit-cancel" type="button"
                      disabled={createBusy}
                      onClick={() => {
                        handleCancelCreate()
                        setCreateMessage('')
                      }}>
                      {appLocale === 'da-DK' ? 'Annuller' : 'Mégse'}
                    </button>
                  )}
                </div>
              ) : (
                <p className="capture-help">
                  {appLocale === 'da-DK' ? t('captureDescription') : <>Írd be vagy diktáld természetesen. Például: „{exampleText}” vagy „Mik a nyitott ügyeink?”</>}
                </p>
              )}

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
                      if (!reminderEditTarget && !dateEditTarget && !noteEditTarget) setAssistantAnswer(null)
                      setQueryResults([])
                      setVoiceError(null)
                    }}
                    placeholder={noteEditTarget ? (updateDraft
                      ? (appLocale === 'da-DK' ? 'Afventer bekræftelse…' : 'Megerősítésre vár…')
                      : (appLocale === 'da-DK' ? 'Skriv din note…' : 'Írd ide a megjegyzést…')) : dateEditTarget ? tr("Az ügy új dátuma/időpontja…") : reminderEditTarget ? tr("Az új emlékeztetés időpontja…") : tr("Mondd vagy írd le, mit intézzünk…")}
                    rows={4}
                    disabled={createBusy || voiceListening || voiceTranscribing || Boolean(noteEditTarget && updateDraft)}
                  />

                  <button
                    className={voiceListening ? 'voice-button listening' : 'voice-button'}
                    type="button"
                    onClick={handleVoiceInput}
                    disabled={createBusy || voiceTranscribing || Boolean(noteEditTarget && updateDraft)}
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
                      || Boolean(noteEditTarget && updateDraft)
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

              {deleteCandidates.length > 0 && (
                <div className="confirmation-card">
                  <strong>{appLocale === 'da-DK'
                    ? 'Vælg hvilken opgave der skal slettes:'
                    : 'Melyik ügyet szeretnéd törölni?'}</strong>
                  <div className="complete-candidates">
                    {deleteCandidates.map((candidate) => (
                      <button className="complete-candidate-button" type="button"
                        disabled={createBusy} key={candidate.id}
                        onClick={() => void handlePrepareDeleteCandidate(candidate)}>
                        {candidate.label}
                      </button>
                    ))}
                  </div>
                  <button className="secondary-button" type="button"
                    onClick={() => setDeleteCandidates([])} disabled={createBusy}>
                    {appLocale === 'da-DK' ? 'Annuller' : 'Mégse'}
                  </button>
                </div>
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
                        {item.notes && (
                          <div className="query-note">
                            <span className="query-note-label">
                              {appLocale === 'da-DK' ? 'Note' : 'Megjegyzés'}
                            </span>
                            <p className="query-note-text">{item.notes}</p>
                          </div>
                        )}
                        {item.status !== 'deleted' && (
                          <details className="query-actions-details">
                            <summary>{appLocale === 'da-DK' ? 'Handlinger' : 'Műveletek'}</summary>
                            <div className="confirmation-actions">
                            {item.status === 'open' && (<>
                            <button
                              className="query-action-button"
                              type="button"
                              onClick={() => startDateEdit(item.id, item.title, item.due_date, item.due_time)}
                              disabled={createBusy}
                            >
                              {tr("Dátum/idő módosítása")}
                            </button>
                            <button
                              className="query-action-button"
                              type="button"
                              onClick={() => startReminderEdit(item.id, item.title, item.due_date, item.due_time, item.reminder_at ?? null)}
                              disabled={createBusy}
                            >
                              {item.reminder_missing ? tr("Emlékeztető beállítása") : tr("Emlékeztető módosítása")}
                            </button>
                            <button
                              className="query-action-button"
                              type="button"
                              onClick={() => startNoteEdit(item.id, item.title, item.due_date, item.due_time)}
                              disabled={createBusy}
                            >
                              {appLocale === 'da-DK' ? 'Tilføj note' : 'Megjegyzés hozzáírása'}
                            </button>
                            {calendarConnected && item.due_date && calendarExportedItemIds !== null
                              && !calendarExportedItemIds.includes(item.id) && (
                              <button
                                className="query-action-button"
                                type="button"
                                onClick={() => void handlePrepareCalendarExport(item.id)}
                                disabled={createBusy || calendarExportBusy}
                              >
                                {appLocale === 'da-DK' ? 'Send til Google Kalender' : 'Google Naptárba küldés'}
                              </button>
                            )}
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
                            </>)}
                            <button className="query-action-button" type="button"
                              disabled={createBusy}
                              onClick={() => void handlePrepareDeleteCandidate(item)}>
                              {appLocale === 'da-DK' ? 'Slet opgaven' : 'Törlés'}
                            </button>
                            </div>
                          </details>
                        )}
                      </div>
                    )
                  })}
                  {calendarConnected && calendarExportStatusError && (
                    <p className="settings-hint" role="status">{calendarExportStatusError}</p>
                  )}
                </div>
              )}

              {calendarExportDraft && (
                <div className="confirmation-card">
                  <strong>{calendarExportDraft.resend
                    ? (appLocale === 'da-DK' ? 'Bekræft genafsendelse til Google Kalender' : 'Google Naptár – újraküldés megerősítése')
                    : (appLocale === 'da-DK' ? 'Bekræft kalenderoverførsel' : 'Google Naptárba küldés megerősítése')}</strong>
                  <p>
                    <strong>{calendarExportDraft.title}</strong>
                    {' – '}
                    {new Date(calendarExportDraft.date + 'T12:00:00').toLocaleDateString(
                      appLocale === 'da-DK' ? 'da-DK' : 'hu-HU', { dateStyle: 'long' },
                    )}
                    {calendarExportDraft.time
                      ? (' – ' + calendarExportDraft.time.slice(0, 5) + '–' +
                        new Date(Date.parse('2000-01-01T' + calendarExportDraft.time + 'Z') + 60 * 60_000)
                          .toISOString().slice(11, 16) +
                        (Number(calendarExportDraft.time.slice(0, 2)) === 23
                          ? (appLocale === 'da-DK' ? ' (næste dag)' : ' (másnap)')
                          : ''))
                      : (appLocale === 'da-DK' ? ' (hele dagen)' : ' (egész napos)')}
                  </p>
                  {calendarExportDraft.notes && (
                    <p className="confirmation-hint" style={{ whiteSpace: 'pre-wrap' }}>
                      <strong>{appLocale === 'da-DK' ? 'Note:' : 'Megjegyzés:'}</strong> {calendarExportDraft.notes}
                    </p>
                  )}
                  <p className="settings-hint">
                    {calendarExportDraft.resend
                      ? (appLocale === 'da-DK'
                        ? 'Denne opgave blev allerede sendt én gang. Vil du kontrollere, om den stadig findes? Hvis den er slettet, kan den oprettes igen. Ellers sker der ingenting.'
                        : 'Ezt az ügyet korábban már elküldtük. Biztosan újra szeretnéd küldeni? Előbb ellenőrizzük a Google Naptárat: ha még megvan, nem küldjük ki, ha törölted, újra létrehozzuk.')
                      : (appLocale === 'da-DK'
                        ? 'Kun denne begivenhed oprettes i din primære Google Kalender. Tidligere begivenheder ændres ikke.'
                        : 'Csak ezt az eseményt hozzuk létre az elsődleges Google Naptáradban. Meglévő naptáreseményeket nem módosítunk.')}
                  </p>
                  <div className="confirmation-actions">
                    <button type="button" className="primary-button"
                      onClick={() => void handleConfirmCalendarExport()} disabled={calendarExportBusy}>
                      {calendarExportBusy
                        ? t('saving')
                        : calendarExportDraft.resend
                          ? (appLocale === 'da-DK' ? 'Ja, tjek og send igen' : 'Igen, ellenőrizd és küldd újra')
                          : (appLocale === 'da-DK' ? 'Ja, send' : 'Igen, küldd')}
                    </button>
                    <button type="button" className="secondary-button"
                      onClick={() => setCalendarExportDraft(null)} disabled={calendarExportBusy}>
                      {appLocale === 'da-DK' ? 'Annuller' : 'Mégse'}
                    </button>
                  </div>
                </div>
              )}

              {calendarExportFeedback && (
                <p className={`notice ${calendarExportFeedback.kind}`} role="status">{calendarExportFeedback.message}</p>
              )}
              {calendarExportError && (
                <p className="notice error" role="alert">{calendarExportError}</p>
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

              {calendarDeleteFollowUp && (
                <div className="confirmation-card delete-confirmation">
                  <strong>{appLocale === 'da-DK'
                    ? 'Skal aftalen også slettes i Google Kalender?'
                    : 'A Google Naptárból is töröljük az eseményt?'}</strong>
                  <p><strong>{calendarDeleteFollowUp.title}</strong></p>
                  <p>{appLocale === 'da-DK'
                    ? 'Opgaven er allerede slettet i assistenten. Google-aftalen bevares, medmindre du godkender sletningen særskilt.'
                    : 'Az ügyet már töröltük az asszisztensből. A Google-esemény megmarad, hacsak itt külön nem kéred a törlését.'}</p>
                  {calendarDeleteError && <p className="notice error">{calendarDeleteError}</p>}
                  <div className="confirmation-actions">
                    <button className="danger-button" type="button" disabled={calendarDeleteBusy}
                      onClick={() => void handleDeleteLinkedGoogleEvent()}>
                      {appLocale === 'da-DK' ? 'Slet også i Google Kalender' : 'Google Naptárból is törlés'}
                    </button>
                    <button className="secondary-button" type="button" disabled={calendarDeleteBusy}
                      onClick={() => {setCalendarDeleteFollowUp(null);setCalendarDeleteError(null)}}>
                      {appLocale === 'da-DK' ? 'Behold i Google Kalender' : 'Maradjon a Google Naptárban'}
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
                  {noteEditTarget && (
                    <p className="note-edit-confirmation-target">
                      <strong>{appLocale === 'da-DK' ? 'Opgave:' : 'Érintett ügy:'}</strong>{' '}
                      {noteEditTarget.title}
                      {noteEditTarget.due_date && (' – ' +
                        new Date(noteEditTarget.due_date + 'T12:00:00').toLocaleDateString(
                          appLocale === 'da-DK' ? 'da-DK' : 'hu-HU', { dateStyle: 'long' },
                        ) + (noteEditTarget.due_time ? ' ' + noteEditTarget.due_time.slice(0, 5) : ''))}
                    </p>
                  )}
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
                  <p className="note-edit-confirmation-target">
                    <strong>{appLocale === 'da-DK' ? 'Opgave:' : 'Érintett ügy:'}</strong>{' '}
                    {reminderFollowUp.title}
                    {reminderFollowUp.due_date && (' – ' +
                      new Date(reminderFollowUp.due_date + 'T12:00:00').toLocaleDateString(
                        appLocale === 'da-DK' ? 'da-DK' : 'hu-HU',
                        { dateStyle: 'long' },
                      ) + (reminderFollowUp.due_time ? ' ' + reminderFollowUp.due_time.slice(0, 5) : ''))}
                  </p>
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
                      onClick={() => startReminderEdit(reminderFollowUp.id, reminderFollowUp.title, reminderFollowUp.due_date ?? null, reminderFollowUp.due_time ?? null, reminderFollowUp.reminder_at)}
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
                  {createDraft.notes && (
                    <p className="confirmation-hint" style={{ whiteSpace: 'pre-wrap' }}>
                      <strong>{appLocale === 'da-DK' ? 'Note:' : 'Megjegyzés:'}</strong> {createDraft.notes}
                    </p>
                  )}
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

                  <section className="push-settings" aria-label={appLocale === 'da-DK' ? 'Google Kalender' : 'Google Naptár'}>
                    <div>
                      <strong>{appLocale === 'da-DK' ? 'Google Kalender' : 'Google Naptár'}</strong>
                      <small>
                        {calendarConnected === null
                          ? (appLocale === 'da-DK' ? 'Kontrollerer forbindelse…' : 'Kapcsolat ellenőrzése…')
                          : calendarConnected
                            ? (appLocale === 'da-DK' ? 'Forbundet. Automatisk overførsel i hver retning kan indstilles separat.' : 'Összekapcsolva. A két szinkronizálási irány külön kapcsolható.')
                            : (appLocale === 'da-DK' ? 'Du kan forbinde din Google-konto.' : 'Összekapcsolhatod a Google-fiókodat.')}
                      </small>
                    </div>
                    {calendarConnected && (
                      <>
                        <label className="settings-toggle">
                          <input type="checkbox"
                            checked={calendarAutoImportEnabled}
                            disabled={calendarBusy || calendarImportNeedsReauth}
                            onChange={(event) => void handleToggleCalendarAutoImport(event.target.checked)}
                          />
                          <span>{appLocale === 'da-DK'
                            ? 'Google Kalender → Assistent: foreslå aftaler og ændringer'
                            : 'Google Naptár → AI családi asszisztens: események és módosítások felajánlása'}</span>
                        </label>
                        <small>{appLocale === 'da-DK'
                          ? 'Kontrol hvert 5. minut: højst én push. Uden svar nævnes aftalen i næste morgenoverblik én gang og udløber næste dags aften. Ingen automatisk import.'
                          : 'Ötpercenkénti ellenőrzés, eseményenként legfeljebb egy push. Válasz nélkül egyszer a következő reggeli briefingben jelezzük, majd másnap éjfélkor lejár. Nincs automatikus átvétel.'}</small>
                        {calendarImportNeedsReauth && (
                          <p className="notice warning">{appLocale === 'da-DK'
                            ? 'Google-adgangen er udløbet. Forbind kalenderen igen.'
                            : 'A Google-engedély lejárt. Kapcsold újra a Google Naptárat.'}</p>
                        )}
                        <label className="settings-toggle">
                          <input type="checkbox"
                            checked={calendarAutoExportEnabled}
                            disabled={calendarBusy || calendarNeedsReauth}
                            onChange={(event) => void handleToggleCalendarAutoExport(event.target.checked)}
                          />
                          <span>{appLocale === 'da-DK'
                            ? 'Send nye og ændrede opgaver til Google Kalender'
                            : 'AI családi asszisztens → Google Naptár: létrehozás és módosítás'}</span>
                        </label>
                        <small>{appLocale === 'da-DK'
                          ? 'Kun nye opgaver fra aktiveringstidspunktet. Med klokkeslæt varer aftalen 1 time, ellers hele dagen. Ingen automatisk genafsendelse. Kontrol ca. hvert 5. minut.'
                          : 'Csak a bekapcsolás után létrehozott saját ügyek. Időponttal 1 órás, időpont nélkül egész napos esemény. Nincs automatikus újraküldés. Ellenőrzés körülbelül 5 percenként.'}</small>
                        {calendarNeedsReauth && (
                          <p className="notice warning">{appLocale === 'da-DK'
                            ? 'Google-tilladelsen er udløbet. Forbind Google Kalender igen for at fortsætte.'
                            : 'A Google-engedély lejárt. Az automatikus küldés leállt. Kapcsold újra a Google Naptárat a folytatáshoz.'}</p>
                        )}
                      </>
                    )}
                    {calendarConnected ? (
                      <button className="secondary-button" type="button"
                        disabled={calendarBusy} onClick={() => void handleDisconnectCalendar()}>
                        {calendarBusy ? t('saving') : (appLocale === 'da-DK' ? 'Afbryd forbindelse' : 'Kapcsolat bontása')}
                      </button>
                    ) : (
                      <button className="secondary-button" type="button"
                        disabled={calendarBusy || calendarConnected === null}
                        onClick={() => void handleConnectCalendar()}>
                        {calendarBusy ? t('loading') : (appLocale === 'da-DK' ? 'Forbind Google Kalender' : 'Google Naptár összekapcsolása')}
                      </button>
                    )}
                  </section>
                  {calendarNotice && <p className="notice success">{calendarNotice}</p>}
                  {calendarError && <p className="notice error">{calendarError}</p>}
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
