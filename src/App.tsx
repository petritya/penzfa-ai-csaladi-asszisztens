import { FormEvent, useEffect, useRef, useState } from 'react'
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

type QueryResultItem = {
  id: string
  title: string
  label: string
  status: 'open' | 'done' | 'deleted'
  due_date: string | null
  due_time: string | null
  subject_display_name: string | null
  subject_member_kind: 'active' | 'managed' | null
  responsible_display_name: string | null
  is_other_owner: boolean
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

function greetingForHour(hour: number) {
  if (hour < 10) return 'Jó reggelt'
  if (hour < 18) return 'Szép napot'
  return 'Jó estét'
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
  const [queryResults, setQueryResults] = useState<QueryResultItem[]>([])
  const [voiceListening, setVoiceListening] = useState(false)
  const [voiceTranscribing, setVoiceTranscribing] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
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
    setUpdateDraft(null)
    setDeleteDraft(null)
    setCreateError(null)
    setCreateSuccess(null)
    setAssistantAnswer(null)
    setQueryResults([])
    setVoiceListening(false)
    setVoiceTranscribing(false)
    setVoiceError(null)
  }, [session?.user.id])

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

  async function transcribeVoiceRecording(audio: Blob, mimeType: string) {
    if (!supabase || !session) return

    setVoiceTranscribing(true)
    setVoiceError(null)

    try {
      const extension = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm'
      const form = new FormData()
      form.append('file', new File([audio], `penzfa-voice.${extension}`, { type: mimeType }))
      form.append(
        'member_names',
        familyMembers.map((member) => member.display_name).join(', '),
      )

      const { data, error } = await supabase.functions.invoke('transcribe-audio', {
        body: form,
      })

      if (error || !data?.text) {
        setVoiceError(error?.message ?? data?.error ?? 'A hang átírása nem sikerült.')
        return
      }

      setCreateMessage(String(data.text).trim())
      setCreateDraft(null)
      setCompleteDraft(null)
      setUpdateDraft(null)
      setDeleteDraft(null)
      setCreateError(null)
      setCreateSuccess(null)
      setAssistantAnswer(null)
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

      recorder.start()
      setVoiceListening(true)
    } catch (error) {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
      mediaRecorderRef.current = null
      mediaStreamRef.current = null
      setVoiceListening(false)
      setVoiceError(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'A mikrofon nincs engedélyezve. Engedélyezd a Pénzfának a mikrofon használatát.'
          : 'A mikrofont most nem sikerült elindítani.',
      )
    }
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
    setQueryResults([])
    setVoiceError(null)

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
      setCreateMessage('')
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

      const structuredItems = Array.isArray(data?.items)
        ? data.items as QueryResultItem[]
        : []

      setQueryResults(structuredItems)
      setAssistantAnswer(
        structuredItems.length
          ? data?.summary ?? null
          : data?.answer ?? data?.error ?? 'Nem találtam választ a kérdésre.',
      )
      setCreateMessage('')
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

    setMessage(null)
    setErrorMessage(null)
    setEmail('')
    setPassword('')
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
      return
    }

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
    const activeUserMember = familyMembers.find((member) => member.user_id === session.user.id) ?? null
    const greeting = greetingForHour(new Date().getHours())
    const exampleManagedMember = familyMembers.find((member) => member.member_kind === 'managed') ?? null
    const exampleText = exampleManagedMember
      ? `${exampleManagedMember.display_name} kontrollja jövő kedden 10-kor.`
      : 'Jövő kedden 10-kor kontroll.'

    return (
      <main className="shell">
        <section className="card">
          <header className="app-header">
            <h1>{familyName ?? 'Belépve'}</h1>
            <p className="lead">
              {familyLoading
                ? 'Család betöltése…'
                : familyName
                  ? activeUserMember
                    ? `${greeting}, ${activeUserMember.display_name}!`
                    : `${greeting}!`
                  : 'Ehhez a felhasználóhoz még nincs család rendelve.'}
            </p>
          </header>

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
                Írd be vagy diktáld természetesen. Például: „{exampleText}” vagy „Mik a nyitott ügyeink?”
              </p>

              <form className="capture-form" onSubmit={handleMessage}>
                <div className="capture-input-shell">
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
                      setQueryResults([])
                      setVoiceError(null)
                    }}
                    placeholder="Mondd vagy írd le, mit intézzünk…"
                    rows={4}
                    disabled={createBusy}
                  />

                  <button
                    className={voiceListening ? 'voice-button listening' : 'voice-button'}
                    type="button"
                    onClick={handleVoiceInput}
                    disabled={createBusy || voiceTranscribing}
                    aria-label={
                      voiceTranscribing
                        ? 'Hang átírása'
                        : voiceListening
                          ? 'Felvétel leállítása'
                          : 'Diktálás indítása'
                    }
                    title={
                      voiceTranscribing
                        ? 'Átírás…'
                        : voiceListening
                          ? 'Felvétel leállítása'
                          : 'Diktálás'
                    }
                  >
                    <span aria-hidden="true">
                      {voiceTranscribing ? '…' : voiceListening ? '■' : '🎙️'}
                    </span>
                  </button>
                </div>

                <div className="capture-actions">
                  <small>
                    {voiceTranscribing
                      ? 'Átírom a felvételt…'
                      : voiceListening
                        ? 'Felvétel folyamatban. Ha kész vagy, koppints újra a mikrofonra.'
                        : 'Koppints a mikrofonra, mondd el, majd koppints újra a leállításhoz.'}
                  </small>
                  <button
                    className="primary-button send-button"
                    type="submit"
                    disabled={createBusy || !createMessage.trim()}
                  >
                    {createBusy ? 'Feldolgozás…' : 'Küldés'}
                  </button>
                </div>

                {voiceError && <p className="voice-error">{voiceError}</p>}
              </form>

              {assistantAnswer && (
                <div className="assistant-answer">
                  <strong>Válasz:</strong>
                  <p>{assistantAnswer}</p>
                </div>
              )}

              {queryResults.length > 0 && (
                <div className="query-results" aria-label="Találatok">
                  {queryResults.map((item) => {
                    const ownerPrefix = item.is_other_owner && item.responsible_display_name
                      ? `${item.responsible_display_name}:`
                      : null
                    const labelWithoutOwner = ownerPrefix && item.label.startsWith(ownerPrefix)
                      ? item.label.slice(ownerPrefix.length).trimStart()
                      : item.label

                    return (
                      <div
                        className={item.is_other_owner ? 'query-item other-owner' : 'query-item'}
                        key={item.id}
                      >
                        <div className="query-label">
                          {ownerPrefix && (
                            <strong className="query-owner-name">{item.responsible_display_name}:</strong>
                          )}{' '}
                          {labelWithoutOwner}
                        </div>
                      </div>
                    )
                  })}
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

          <details className="secondary-details account-details">
            <summary>Fiók és értesítések</summary>

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

            <button className="secondary-button sign-out-button" type="button" onClick={handleSignOut}>
              Kijelentkezés
            </button>
          </details>

          {errorMessage && <p className="notice error">{errorMessage}</p>}
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
