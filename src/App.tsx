import { FormEvent, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { hasSupabaseConfig, supabase } from './lib/supabase'

type AuthMode = 'sign-in' | 'sign-up'

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

type PushStatus = 'idle' | 'loading' | 'ready' | 'enabled' | 'blocked' | 'unsupported' | 'error'

type UserSettings = {
  briefing_enabled: boolean
  briefing_time: string
  notify_partner_on_complete: boolean
}

type OneSignalClient = {
  init: (options: {
    appId: string
    serviceWorkerPath: string
    serviceWorkerParam: { scope: string }
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
    if (subscription.optedIn && subscription.id) return true
    await new Promise((resolve) => window.setTimeout(resolve, 300))
  }

  return false
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

  const [pushStatus, setPushStatus] = useState<PushStatus>('idle')
  const [pushAppId, setPushAppId] = useState<string | null>(null)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)

  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settings, setSettings] = useState<UserSettings>({
    briefing_enabled: true,
    briefing_time: '07:00',
    notify_partner_on_complete: false,
  })
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)

  const [createMessage, setCreateMessage] = useState('')
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createSuccess, setCreateSuccess] = useState<string | null>(null)
  const [completeDraft, setCompleteDraft] = useState<CompleteDraft | null>(null)
  const [updateDraft, setUpdateDraft] = useState<UpdateDraft | null>(null)
  const [deleteDraft, setDeleteDraft] = useState<DeleteDraft | null>(null)
  const [assistantAnswer, setAssistantAnswer] = useState<string | null>(null)

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
        await oneSignal.login(currentSession.user.id)

        if (cancelled) return

        if (Notification.permission === 'denied') {
          setPushStatus('blocked')
        } else if (
          Notification.permission === 'granted'
          && oneSignal.User.PushSubscription.optedIn
          && oneSignal.User.PushSubscription.id
        ) {
          setPushStatus('enabled')
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
    if (!supabase || !session || !familyName) {
      setSettings({
        briefing_enabled: true,
        briefing_time: '07:00',
        notify_partner_on_complete: false,
      })
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

      setSettings({
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
        setPushStatus('error')
        setPushError(
          'A böngésző engedélyezte az értesítéseket, de a OneSignal push-feliratkozás még nem jött létre.',
        )
      }
    } catch (error) {
      setPushStatus('error')
      setPushError(error instanceof Error ? error.message : 'Az értesítések bekapcsolása nem sikerült.')
    } finally {
      setPushBusy(false)
    }
  }

  async function handleSaveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !session) return

    setSettingsBusy(true)
    setSettingsError(null)
    setSettingsMessage(null)

    const { data, error } = await supabase.functions.invoke('core', {
      body: {
        action: 'update_settings',
        briefing_enabled: settings.briefing_enabled,
        briefing_time: settings.briefing_time,
        notify_partner_on_complete: settings.notify_partner_on_complete,
      },
    })

    setSettingsBusy(false)

    if (error || data?.error) {
      setSettingsError(error?.message ?? data?.error ?? 'A beállításokat nem sikerült menteni.')
      return
    }

    if (data?.settings) {
      setSettings({
        briefing_enabled: Boolean(data.settings.briefing_enabled),
        briefing_time: String(data.settings.briefing_time ?? settings.briefing_time).slice(0, 5),
        notify_partner_on_complete: Boolean(data.settings.notify_partner_on_complete),
      })
    }

    setSettingsMessage('Beállítások mentve.')
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
          `A család elkészült, de a második ügygazda meghívása nem sikerült: ${data.second_owner_invitation_warning}`,
        )
      } else {
        setSetupMessage('A család elkészült.')
      }

      setFamilyRefreshKey((value) => value + 1)
      return
    }

    setSetupError(data?.error ?? 'A családot most nem sikerült létrehozni.')
  }

  async function handleMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return

    const message = createMessage.trim()
    if (!message) return

    setCreateBusy(true)
    setCreateDraft(null)
    setCompleteDraft(null)
    setUpdateDraft(null)
    setDeleteDraft(null)
    setCreateError(null)
    setCreateSuccess(null)
    setAssistantAnswer(null)

    const { data: intentData, error: intentError } = await supabase.functions.invoke('core', {
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
      return
    }

    if (intentData?.intent === 'query') {
      const { data, error } = await supabase.functions.invoke('core', {
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

      setAssistantAnswer(
        data?.answer ?? data?.error ?? 'Nem találtam választ a kérdésre.',
      )
      return
    }

    if (intentData?.intent === 'complete') {
      const { data, error } = await supabase.functions.invoke('core', {
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

      if (data?.status === 'future_event_needs_date') {
        setAssistantAnswer(
          data.prompt ?? 'Ez az esemény még jövőbeli. Írd meg, mikor történt meg valójában.',
        )
        return
      }

      setAssistantAnswer(
        data?.error ?? 'Nem találtam egyértelműen ilyen nyitott ügyet.',
      )
      return
    }

    if (intentData?.intent === 'update') {
      const { data, error } = await supabase.functions.invoke('core', {
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
        return
      }

      setAssistantAnswer(
        data?.error ?? 'Nem találtam egyértelműen a módosítandó ügyet.',
      )
      return
    }

    if (intentData?.intent === 'delete') {
      const { data, error } = await supabase.functions.invoke('core', {
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

    const { data, error } = await supabase.functions.invoke('core', {
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
      return
    }

    if (data?.status === 'duplicate') {
      setCreateError(data.message ?? 'Ez az ügy már szerepel a nyitott ügyek között.')
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

    const { data, error } = await supabase.functions.invoke('core', {
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
      setCreateSuccess(`Törölve: ${data.item?.title ?? 'ügy'}`)
      setCreateMessage('')
      setDeleteDraft(null)
      return
    }

    setCreateError(data?.error ?? 'Az ügyet most nem sikerült törölni.')
  }

  async function handleConfirmUpdate() {
    if (!supabase || !updateDraft) return

    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)
    setAssistantAnswer(null)

    const { data, error } = await supabase.functions.invoke('core', {
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
      setCreateSuccess(`Módosítva: ${data.item?.title ?? 'ügy'}`)
      setCreateMessage('')
      setUpdateDraft(null)
      return
    }

    setCreateError(data?.error ?? 'Az ügyet most nem sikerült módosítani.')
  }

  async function handleConfirmComplete() {
    if (!supabase || !completeDraft) return

    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)
    setAssistantAnswer(null)

    const { data, error } = await supabase.functions.invoke('core', {
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
      setCreateSuccess(`Készre jelölve: ${data.item?.title ?? 'ügy'}`)
      setCreateMessage('')
      setCompleteDraft(null)

      if (data.partner_notification_warning) {
        setAssistantAnswer(data.partner_notification_warning)
      }
      return
    }

    setCreateError(data?.error ?? 'Az ügyet most nem sikerült készre jelölni.')
  }

  async function handleConfirmCreate() {
    if (!supabase || !createDraft) return

    setCreateBusy(true)
    setCreateError(null)
    setCreateSuccess(null)

    const { data, error } = await supabase.functions.invoke('core', {
      body: {
        action: 'confirm_create',
        draft: createDraft,
      },
    })

    setCreateBusy(false)

    if (error) {
      setCreateError(error.message)
      return
    }

    if (data?.status === 'created') {
      setCreateSuccess(`Rögzítve: ${data.item?.title ?? createDraft.title}`)
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

  function handleCancelCreate() {
    setCreateDraft(null)
    setCompleteDraft(null)
    setUpdateDraft(null)
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
        : await supabase.auth.signUp({ email, password })

    setSubmitting(false)

    if (result.error) {
      setErrorMessage(result.error.message)
      return
    }

    if (mode === 'sign-up' && !result.data.session) {
      setMessage('A regisztráció elkészült. Nyisd meg a megerősítő e-mailt, majd jelentkezz be.')
      setMode('sign-in')
      setPassword('')
      return
    }

    setMessage(mode === 'sign-up' ? 'Sikeres regisztráció.' : 'Sikeres belépés.')
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

    const { error } = await supabase.auth.signOut()

    if (error) {
      setErrorMessage(error.message)
    }
  }

  if (!hasSupabaseConfig) {
    return (
      <main className="shell">
        <section className="card">
          <p className="eyebrow">Pénzfa</p>
          <h1>Beállítás szükséges</h1>
          <p className="lead">
            A Cloudflare deployból hiányzik a Supabase projekt URL-je vagy publishable key-je.
          </p>
          <p className="notice error">
            Add hozzá a VITE_SUPABASE_URL és VITE_SUPABASE_PUBLISHABLE_KEY környezeti változókat,
            majd indíts új deployt.
          </p>
        </section>
      </main>
    )
  }

  if (loadingSession) {
    return (
      <main className="shell">
        <section className="card">
          <p className="eyebrow">Pénzfa</p>
          <p>Belépés ellenőrzése…</p>
        </section>
      </main>
    )
  }

  if (session) {
    return (
      <main className="shell">
        <section className="card">
          <p className="eyebrow">Pénzfa</p>
          <h1>{familyName ?? 'Belépve'}</h1>
          <p className="lead">
            {familyLoading
              ? 'Család betöltése…'
              : familyName
                ? 'A közös családi tér elérhető.'
                : 'Ehhez a felhasználóhoz még nincs család rendelve.'}
          </p>

          {familyError && <p className="notice error">{familyError}</p>}

          {!familyLoading && !familyName && !familyError && (
            <section className="setup-block" aria-label="Család létrehozása">
              <h2>Család létrehozása</h2>
              <p className="capture-help">
                Elsőként add meg, hogyan hívjuk a családot és téged. A többi mező opcionális.
              </p>

              <form className="setup-form" onSubmit={handleFamilySetup}>
                <label>
                  Család neve
                  <input
                    type="text"
                    value={setupFamilyName}
                    onChange={(event) => setSetupFamilyName(event.target.value)}
                    placeholder="Például: Család"
                    required
                  />
                </label>

                <label>
                  Saját megszólítás
                  <input
                    type="text"
                    value={setupDisplayName}
                    onChange={(event) => setSetupDisplayName(event.target.value)}
                    placeholder="Például: Apa"
                    required
                  />
                </label>

                <label>
                  Kezelt családtagok
                  <textarea
                    value={setupManagedMembers}
                    onChange={(event) => setSetupManagedMembers(event.target.value)}
                    placeholder="Például: Mamus, Bence"
                    rows={2}
                  />
                  <small>Vesszővel vagy új sorral válaszd el a neveket.</small>
                </label>

                <label>
                  Második ügygazda e-mailje
                  <input
                    type="email"
                    value={setupSecondOwnerEmail}
                    onChange={(event) => setSetupSecondOwnerEmail(event.target.value)}
                    placeholder="Opcionális"
                  />
                </label>

                <button
                  className="primary-button"
                  type="submit"
                  disabled={setupBusy || !setupFamilyName.trim() || !setupDisplayName.trim()}
                >
                  {setupBusy ? 'Létrehozás…' : 'Család létrehozása'}
                </button>
              </form>

              {setupMessage && <p className="notice success">{setupMessage}</p>}
              {setupError && <p className="notice error">{setupError}</p>}
            </section>
          )}

          {familyName && (
            <section className="capture-block capture-primary" aria-label="Kommunikáció">
              <h2>Mit intézzünk?</h2>
              <p className="capture-help">
                Írd be vagy diktáld természetesen. Például: „Mamusnak jövő kedden 10-kor kontroll.” vagy „Mik a nyitott ügyeink?”
              </p>

              <form className="capture-form" onSubmit={handleMessage}>
                <textarea
                  value={createMessage}
                  onChange={(event) => {
                    setCreateMessage(event.target.value)
                    setCreateDraft(null)
                    setCompleteDraft(null)
                    setUpdateDraft(null)
                    setDeleteDraft(null)
                    setCreateError(null)
                    setCreateSuccess(null)
                    setAssistantAnswer(null)
                  }}
                  placeholder="Mit szeretnél?"
                  rows={3}
                  disabled={createBusy}
                />

                <button
                  className="primary-button"
                  type="submit"
                  disabled={createBusy || !createMessage.trim()}
                >
                  {createBusy ? 'Feldolgozás…' : 'Küldés'}
                </button>
              </form>

              {assistantAnswer && (
                <div className="assistant-answer">
                  <strong>Válasz:</strong>
                  <p>{assistantAnswer}</p>
                </div>
              )}

              {deleteDraft && (
                <div className="confirmation-card delete-confirmation">
                  <strong>Törlés megerősítése:</strong>
                  <p>{deleteDraft.confirmation_text}</p>
                  <div className="confirmation-actions">
                    <button
                      className="danger-button"
                      type="button"
                      onClick={handleConfirmDelete}
                      disabled={createBusy}
                    >
                      Igen, töröld
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={handleCancelCreate}
                      disabled={createBusy}
                    >
                      Mégse
                    </button>
                  </div>
                </div>
              )}

              {updateDraft && (
                <div className="confirmation-card">
                  <strong>Megerősítés:</strong>
                  <p>{updateDraft.confirmation_text}</p>
                  <div className="confirmation-actions">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={handleConfirmUpdate}
                      disabled={createBusy}
                    >
                      Igen, módosítsd
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={handleCancelCreate}
                      disabled={createBusy}
                    >
                      Mégse
                    </button>
                  </div>
                </div>
              )}

              {completeDraft && (
                <div className="confirmation-card">
                  <strong>Megerősítés:</strong>
                  <p>{completeDraft.confirmation_text}</p>
                  <div className="confirmation-actions">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={handleConfirmComplete}
                      disabled={createBusy}
                    >
                      Igen, jelöld késznek
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={handleCancelCreate}
                      disabled={createBusy}
                    >
                      Mégse
                    </button>
                  </div>
                </div>
              )}

              {createDraft && (
                <div className="confirmation-card">
                  <strong>Ezt értettem:</strong>
                  <p>{createDraft.confirmation_text}</p>
                  <div className="confirmation-actions">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={handleConfirmCreate}
                      disabled={createBusy}
                    >
                      Igen, rögzítsd
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={handleCancelCreate}
                      disabled={createBusy}
                    >
                      Mégse
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
              <summary>Családtagok</summary>
              <ul className="member-list">
                {familyMembers.map((member) => (
                  <li key={`${member.family_id}-${member.display_name}`}>
                    <span>{member.display_name}</span>
                    <small>
                      {member.member_kind === 'active' ? 'Aktív felhasználó' : 'Kezelt családtag'}
                    </small>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {familyName && (
            <details className="secondary-details settings-details">
              <summary>Beállítások</summary>
              {settingsLoading ? (
                <p className="settings-hint">Betöltés…</p>
              ) : (
                <form className="settings-form" onSubmit={handleSaveSettings}>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={settings.briefing_enabled}
                      onChange={(event) => {
                        setSettings((current) => ({
                          ...current,
                          briefing_enabled: event.target.checked,
                        }))
                        setSettingsMessage(null)
                      }}
                    />
                    <span>Reggeli briefing</span>
                  </label>

                  <label className="settings-time">
                    <span>Briefing időpontja</span>
                    <input
                      type="time"
                      value={settings.briefing_time}
                      disabled={!settings.briefing_enabled}
                      onChange={(event) => {
                        setSettings((current) => ({
                          ...current,
                          briefing_time: event.target.value,
                        }))
                        setSettingsMessage(null)
                      }}
                      required
                    />
                  </label>

                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={settings.notify_partner_on_complete}
                      onChange={(event) => {
                        setSettings((current) => ({
                          ...current,
                          notify_partner_on_complete: event.target.checked,
                        }))
                        setSettingsMessage(null)
                      }}
                    />
                    <span>Szóljon a másik ügygazdának, ha készre jelölök egy ügyet</span>
                  </label>

                  {settingsMessage && <p className="notice success">{settingsMessage}</p>}
                  {settingsError && <p className="notice error">{settingsError}</p>}

                  <button className="secondary-button" type="submit" disabled={settingsBusy}>
                    {settingsBusy ? 'Mentés…' : 'Beállítások mentése'}
                  </button>
                </form>
              )}
            </details>
          )}

          <dl className="account">
            <div>
              <dt>Belépett fiók</dt>
              <dd>{session.user.email ?? 'Ismeretlen e-mail'}</dd>
            </div>
          </dl>

          {familyName && (
            <section className="push-settings" aria-label="Értesítések">
              <div>
                <strong>Értesítések</strong>
                {pushStatus === 'loading' && <small>Ellenőrzés…</small>}
                {pushStatus === 'enabled' && <small className="push-enabled">Bekapcsolva ezen az eszközön.</small>}
                {pushStatus === 'blocked' && <small>Az értesítések le vannak tiltva a böngésző/PWA beállításaiban.</small>}
                {pushStatus === 'unsupported' && <small>Ez a böngésző vagy eszköz nem támogatja a webes push értesítéseket.</small>}
                {pushStatus === 'error' && <small>{pushError ?? 'A push szolgáltatás nem érhető el.'}</small>}
                {pushStatus === 'ready' && <small>Kapcsold be, hogy ezen az eszközön megérkezzenek a családi értesítések.</small>}
              </div>

              {pushStatus === 'ready' && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={handleEnablePush}
                  disabled={pushBusy}
                >
                  {pushBusy ? 'Bekapcsolás…' : 'Értesítések bekapcsolása'}
                </button>
              )}
            </section>
          )}

          {errorMessage && <p className="notice error">{errorMessage}</p>}

          <button className="secondary-button" type="button" onClick={handleSignOut}>
            Kijelentkezés
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">Pénzfa</p>
        <h1>AI családi asszisztens</h1>
        <p className="lead">
          {mode === 'sign-in'
            ? 'Jelentkezz be az MVP-be.'
            : 'Hozd létre az első felhasználói fiókot.'}
        </p>

        <div className="auth-tabs" aria-label="Belépési mód">
          <button
            className={mode === 'sign-in' ? 'tab active' : 'tab'}
            type="button"
            onClick={() => {
              setMode('sign-in')
              setMessage(null)
              setErrorMessage(null)
            }}
          >
            Belépés
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
            Regisztráció
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
            Jelszó
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
              ? 'Folyamatban…'
              : mode === 'sign-in'
                ? 'Belépés'
                : 'Fiók létrehozása'}
          </button>
        </form>
      </section>
    </main>
  )
}
