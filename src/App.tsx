import { FormEvent, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import {
  initializePush,
  isPushConfigured,
  logoutPush,
  requestPushPermission,
} from './lib/onesignal'

type AuthMode = 'sign-in' | 'sign-up'
type WorkMode = 'create' | 'update' | 'complete' | 'query'

type CreateDraft = {
  subject_member_id: string | null
  subject_display_name: string | null
  title: string
  item_type: 'task' | 'event' | 'deadline'
  notes: string | null
  due_date: string | null
  due_time: string | null
  first_reminder_at: string | null
  reminder_phrase: string | null
  confirmation_text: string
}

type UpdateDraft = {
  pending_action_id: string
  target_item_id: string
  confirmation_text: string
}

type UpdateCandidate = {
  id: string
  label: string
  title: string
  due_date: string | null
  due_time: string | null
  subject_display_name: string | null
}

type UpdateChanges = {
  due_date: string | null
  due_time: string | null
  title: string | null
}

type CompleteDraft = {
  pending_action_id: string
  target_item_id: string
  confirmation_text: string
}

type FamilyStructure = {
  owners: Array<{
    id: string
    display_name: string
    is_current_user: boolean
  }>
  managed_members: Array<{
    id: string
    display_name: string
  }>
  pending_second_owner_invitation: boolean
  can_invite_second_owner: boolean
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loadingSession, setLoadingSession] = useState(true)
  const [mode, setMode] = useState<AuthMode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const [familyName, setFamilyName] = useState('Család')
  const [displayName, setDisplayName] = useState('')
  const [secondOwnerEmail, setSecondOwnerEmail] = useState('')
  const [managedMembersText, setManagedMembersText] = useState('')
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null)
  const [pendingOwnerInvitation, setPendingOwnerInvitation] = useState(false)
  const [invitationFamilyName, setInvitationFamilyName] = useState<string | null>(null)
  const [inviteDisplayName, setInviteDisplayName] = useState('')
  const [invitePassword, setInvitePassword] = useState('')
  const [familyStructure, setFamilyStructure] = useState<FamilyStructure | null>(null)
  const [ownerInviteEmail, setOwnerInviteEmail] = useState('')
  const [ownerInviteBusy, setOwnerInviteBusy] = useState(false)
  const [ownerInviteMessage, setOwnerInviteMessage] = useState<string | null>(null)

  const [workMode, setWorkMode] = useState<WorkMode>('create')
  const [naturalMessage, setNaturalMessage] = useState('')
  const [draft, setDraft] = useState<CreateDraft | null>(null)
  const [reminderFollowupOpen, setReminderFollowupOpen] = useState(false)
  const [reminderFollowupText, setReminderFollowupText] = useState('')
  const [updateDraft, setUpdateDraft] = useState<UpdateDraft | null>(null)
  const [updateCandidates, setUpdateCandidates] = useState<UpdateCandidate[]>([])
  const [updateChanges, setUpdateChanges] = useState<UpdateChanges | null>(null)
  const [completeDraft, setCompleteDraft] = useState<CompleteDraft | null>(null)
  const [completeCandidates, setCompleteCandidates] = useState<UpdateCandidate[]>([])
  const [flowMessage, setFlowMessage] = useState<string | null>(null)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [queryAnswer, setQueryAnswer] = useState<string | null>(null)
  const [flowBusy, setFlowBusy] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushMessage, setPushMessage] = useState<string | null>(null)
  const [briefingEnabled, setBriefingEnabled] = useState(true)
  const [briefingTime, setBriefingTime] = useState('07:00')
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoadingSession(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setLoadingSession(false)
      setSetupComplete(null)
      setPendingOwnerInvitation(false)
      setInvitationFamilyName(null)
      setInviteDisplayName('')
      setInvitePassword('')
      setFamilyStructure(null)
      setOwnerInviteEmail('')
      setOwnerInviteMessage(null)
      setSettingsLoaded(false)
      setSettingsMessage(null)
      setDraft(null)
      setReminderFollowupOpen(false)
      setReminderFollowupText('')
      setUpdateDraft(null)
      setUpdateCandidates([])
      setUpdateChanges(null)
      setCompleteDraft(null)
      setCompleteCandidates([])
      setFlowMessage(null)
      setFlowError(null)
      setQueryAnswer(null)
    })

    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session || setupComplete !== null) return

    void invokeCore({ action: 'setup_status' })
      .then((data) => {
        setSetupComplete(Boolean(data.setup_complete))
        setPendingOwnerInvitation(Boolean(data.pending_owner_invitation))
        setInvitationFamilyName(data.invitation_family_name ?? null)
      })
      .catch(() => {
        setSetupComplete(false)
        setPendingOwnerInvitation(false)
      })
  }, [session, setupComplete])

  useEffect(() => {
    if (!session || setupComplete !== true || settingsLoaded) return

    void invokeCore({ action: 'get_settings' })
      .then((data) => {
        setBriefingEnabled(Boolean(data.settings?.briefing_enabled))
        setBriefingTime(String(data.settings?.briefing_time ?? '07:00:00').slice(0, 5))
        setSettingsLoaded(true)
      })
      .catch(() => {
        setSettingsLoaded(true)
      })
  }, [session, setupComplete, settingsLoaded])

  useEffect(() => {
    if (!session || setupComplete !== true || familyStructure) return

    void invokeCore({ action: 'get_family_structure' })
      .then((data) => setFamilyStructure(data as FamilyStructure))
      .catch(() => setFamilyStructure(null))
  }, [session, setupComplete, familyStructure])

  useEffect(() => {
    if (!session || !isPushConfigured()) return

    void initializePush(session.user.id).catch(() => {
      setPushMessage('A push értesítések inicializálása nem sikerült.')
    })
  }, [session])

  const managedMembers = useMemo(
    () =>
      managedMembersText
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    [managedMembersText],
  )

  async function invokeCore(body: Record<string, unknown>) {
    const { data, error } = await supabase.functions.invoke('core', { body })

    if (error) {
      throw new Error(error.message)
    }

    if (data?.error) {
      throw new Error(data.error)
    }

    return data
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
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
    setErrorMessage(null)

    try {
      await logoutPush()
    } catch {
      // A kijelentkezést nem akadályozza a push szolgáltatás hibája.
    }

    const { error } = await supabase.auth.signOut()

    if (error) setErrorMessage(error.message)
  }

  async function handleEnablePush() {
    setPushBusy(true)
    setPushMessage(null)

    try {
      if (!session) return
      await initializePush(session.user.id)
      const granted = await requestPushPermission()
      setPushMessage(
        granted
          ? 'A push értesítések engedélyezve vannak.'
          : 'A böngészőben nem engedélyezted a push értesítéseket.',
      )
    } catch (error) {
      setPushMessage(
        error instanceof Error
          ? error.message
          : 'Nem sikerült engedélyezni a push értesítéseket.',
      )
    } finally {
      setPushBusy(false)
    }
  }


  async function handleSaveBriefingSettings() {
    setSettingsBusy(true)
    setSettingsMessage(null)

    try {
      const data = await invokeCore({
        action: 'update_settings',
        briefing_enabled: briefingEnabled,
        briefing_time: briefingTime,
      })

      setBriefingEnabled(Boolean(data.settings?.briefing_enabled))
      setBriefingTime(String(data.settings?.briefing_time ?? briefingTime).slice(0, 5))
      setSettingsMessage('A reggeli briefing beállításai elmentve.')
    } catch (error) {
      setSettingsMessage(
        error instanceof Error
          ? error.message
          : 'Nem sikerült elmenteni a briefing beállításait.',
      )
    } finally {
      setSettingsBusy(false)
    }
  }

  async function handleBootstrap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFlowBusy(true)
    setFlowError(null)
    setFlowMessage(null)

    try {
      const data = await invokeCore({
        action: 'bootstrap',
        family_name: familyName.trim(),
        display_name: displayName.trim(),
        second_owner_email: secondOwnerEmail.trim(),
        managed_members: managedMembers,
        redirect_to: window.location.origin,
      })
      setSetupComplete(true)
      setFamilyStructure(null)
      setFlowMessage(
        data.second_owner_invitation_warning
          ? `A család elkészült, de a második ügygazda meghívója nem ment ki: ${data.second_owner_invitation_warning}`
          : data.second_owner_invitation_created
            ? 'A család elkészült, a második ügygazda meghívója kiment.'
            : 'A család alapadatai elkészültek.',
      )
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Nem sikerült létrehozni a családot.')
    } finally {
      setFlowBusy(false)
    }
  }

  async function handleAcceptOwnerInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session) return

    setFlowBusy(true)
    setFlowError(null)
    setFlowMessage(null)

    try {
      if (invitePassword.trim()) {
        if (invitePassword.length < 6) {
          throw new Error('A jelszó legalább 6 karakter legyen.')
        }

        const { error: passwordError } = await supabase.auth.updateUser({
          password: invitePassword,
        })

        if (passwordError) throw passwordError
      }

      await invokeCore({
        action: 'accept_owner_invitation',
        display_name: inviteDisplayName.trim(),
      })

      setPendingOwnerInvitation(false)
      setInvitationFamilyName(null)
      setSetupComplete(true)
      setSettingsLoaded(false)
      setFamilyStructure(null)
      setInvitePassword('')
      setFlowMessage('A meghívást elfogadtad. Mostantól ügygazdaként használod a családi asszisztenst.')
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Nem sikerült elfogadni a meghívást.')
    } finally {
      setFlowBusy(false)
    }
  }

  async function handleInviteSecondOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setOwnerInviteBusy(true)
    setOwnerInviteMessage(null)
    setFlowError(null)

    try {
      await invokeCore({
        action: 'invite_second_owner',
        email: ownerInviteEmail.trim(),
        redirect_to: window.location.origin,
      })

      setOwnerInviteEmail('')
      setOwnerInviteMessage('A meghívó elküldve. A második ügygazda elfogadására várunk.')
      setFamilyStructure(null)
    } catch (error) {
      setOwnerInviteMessage(
        error instanceof Error ? error.message : 'Nem sikerült elküldeni a meghívót.',
      )
    } finally {
      setOwnerInviteBusy(false)
    }
  }

  async function handleInterpret(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFlowBusy(true)
    setFlowError(null)
    setFlowMessage(null)
    setDraft(null)
    setUpdateDraft(null)
    setUpdateCandidates([])
    setUpdateChanges(null)
    setCompleteDraft(null)
    setCompleteCandidates([])
    setQueryAnswer(null)

    try {
      const action =
        workMode === 'create'
          ? 'interpret_create'
          : workMode === 'update'
            ? 'interpret_update'
            : workMode === 'complete'
              ? 'interpret_complete'
              : 'query_items'

      const data = await invokeCore({
        action,
        message: naturalMessage.trim(),
      })

      if (workMode === 'query') {
        setQueryAnswer(data.answer ?? 'Nem találtam választ.')
        return
      }

      if (workMode === 'create') {
        if (data.status === 'duplicate') {
          setFlowError(data.message ?? 'Ez az ügy már szerepel a nyitott ügyek között.')
          return
        }

        setDraft(data.draft as CreateDraft)
        return
      }

      if (workMode === 'update') {
        if (data.status === 'needs_confirmation') {
          setUpdateDraft(data.draft as UpdateDraft)
          return
        }

        if (data.status === 'choose_target') {
          setUpdateCandidates(data.candidates as UpdateCandidate[])
          setUpdateChanges(data.changes as UpdateChanges)
          return
        }

        if (data.status === 'needs_change_details') {
          setFlowError(data.error ?? 'Pontosítsd, mire szeretnéd módosítani az ügyet.')
          return
        }

        if (data.status === 'no_match') {
          setFlowError(data.error ?? 'Nem találtam megfelelő ügyet.')
        }

        return
      }

      if (data.status === 'needs_confirmation') {
        setCompleteDraft(data.draft as CompleteDraft)
        return
      }

      if (data.status === 'choose_target') {
        setCompleteCandidates(data.candidates as UpdateCandidate[])
        return
      }

      if (data.status === 'no_match') {
        setFlowError(data.error ?? 'Nem találtam megfelelő nyitott ügyet.')
      }
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Nem sikerült értelmezni a kérést.')
    } finally {
      setFlowBusy(false)
    }
  }

  async function handleConfirmCreate() {
    if (!draft) return

    setFlowBusy(true)
    setFlowError(null)
    setFlowMessage(null)

    try {
      const data = await invokeCore({
        action: 'confirm_create',
        draft,
      })

      if (data.status === 'duplicate') {
        setFlowError(data.message ?? 'Ez az ügy már szerepel a nyitott ügyek között.')
        setDraft(null)
        setReminderFollowupOpen(false)
        setReminderFollowupText('')
        return
      }

      setFlowMessage(`Rögzítve: ${data.item.title}`)
      setNaturalMessage('')
      setDraft(null)
      setReminderFollowupOpen(false)
      setReminderFollowupText('')
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Nem sikerült rögzíteni a bejegyzést.')
    } finally {
      setFlowBusy(false)
    }
  }


  async function handleAddCreateReminder() {
    if (!draft || !reminderFollowupText.trim()) return

    setFlowBusy(true)
    setFlowError(null)
    setFlowMessage(null)

    try {
      const reminderData = await invokeCore({
        action: 'add_create_reminder',
        draft,
        reminder_phrase: reminderFollowupText.trim(),
      })

      const updatedDraft = reminderData.draft as CreateDraft

      const createData = await invokeCore({
        action: 'confirm_create',
        draft: updatedDraft,
      })

      if (createData.status === 'duplicate') {
        setFlowError(createData.message ?? 'Ez az ügy már szerepel a nyitott ügyek között.')
        setDraft(null)
        setReminderFollowupOpen(false)
        setReminderFollowupText('')
        return
      }

      setFlowMessage(`Rögzítve: ${createData.item.title}. Emlékeztető: ${updatedDraft.reminder_phrase}.`)
      setNaturalMessage('')
      setDraft(null)
      setReminderFollowupOpen(false)
      setReminderFollowupText('')
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Nem sikerült beállítani az emlékeztetőt és rögzíteni az ügyet.')
    } finally {
      setFlowBusy(false)
    }
  }


  async function handleChooseUpdateTarget(targetItemId: string) {
    if (!updateChanges) return

    setFlowBusy(true)
    setFlowError(null)

    try {
      const data = await invokeCore({
        action: 'prepare_update_target',
        target_item_id: targetItemId,
        changes: updateChanges,
      })

      if (data.status === 'needs_confirmation') {
        setUpdateDraft(data.draft as UpdateDraft)
        setUpdateCandidates([])
      } else {
        setFlowError(data.error ?? 'A módosítást még pontosítani kell.')
      }
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Nem sikerült kiválasztani az ügyet.')
    } finally {
      setFlowBusy(false)
    }
  }

  async function handleConfirmUpdate() {
    if (!updateDraft) return

    setFlowBusy(true)
    setFlowError(null)
    setFlowMessage(null)

    try {
      const data = await invokeCore({
        action: 'confirm_update',
        pending_action_id: updateDraft.pending_action_id,
      })

      setFlowMessage(`Módosítva: ${data.item.title}`)
      setNaturalMessage('')
      setUpdateDraft(null)
      setUpdateChanges(null)
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Nem sikerült végrehajtani a módosítást.')
    } finally {
      setFlowBusy(false)
    }
  }

  async function handleCancelUpdate() {
    const pendingActionId = updateDraft?.pending_action_id

    setUpdateDraft(null)
    setUpdateCandidates([])
    setUpdateChanges(null)

    if (!pendingActionId) return

    try {
      await invokeCore({
        action: 'cancel_pending',
        pending_action_id: pendingActionId,
      })
    } catch {
      // A felhasználói felületen már megszakítottuk a műveletet.
    }
  }


  async function handleChooseCompleteTarget(targetItemId: string) {
    setFlowBusy(true)
    setFlowError(null)

    try {
      const data = await invokeCore({
        action: 'prepare_complete_target',
        target_item_id: targetItemId,
      })

      if (data.status === 'needs_confirmation') {
        setCompleteDraft(data.draft as CompleteDraft)
        setCompleteCandidates([])
      } else {
        setFlowError(data.error ?? 'Nem sikerült előkészíteni a lezárást.')
      }
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Nem sikerült kiválasztani az ügyet.')
    } finally {
      setFlowBusy(false)
    }
  }

  async function handleConfirmComplete() {
    if (!completeDraft) return

    setFlowBusy(true)
    setFlowError(null)
    setFlowMessage(null)

    try {
      const data = await invokeCore({
        action: 'confirm_complete',
        pending_action_id: completeDraft.pending_action_id,
      })

      setFlowMessage(`Készre jelölve: ${data.item.title}`)
      setNaturalMessage('')
      setCompleteDraft(null)
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Nem sikerült lezárni az ügyet.')
    } finally {
      setFlowBusy(false)
    }
  }

  async function handleCancelComplete() {
    const pendingActionId = completeDraft?.pending_action_id

    setCompleteDraft(null)
    setCompleteCandidates([])

    if (!pendingActionId) return

    try {
      await invokeCore({
        action: 'cancel_pending',
        pending_action_id: pendingActionId,
      })
    } catch {
      // A felhasználói felületen már megszakítottuk a műveletet.
    }
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
        <section className="card wide">
          <div className="topbar">
            <div>
              <p className="eyebrow">Pénzfa</p>
              <h1>AI családi asszisztens</h1>
            </div>
            <button className="secondary-button" type="button" onClick={handleSignOut}>
              Kijelentkezés
            </button>
          </div>

          <p className="lead">{session.user.email ?? 'Bejelentkezett felhasználó'}</p>

          {isPushConfigured() && (
            <div className="push-setup">
              <button
                className="secondary-button"
                type="button"
                onClick={handleEnablePush}
                disabled={pushBusy}
              >
                {pushBusy ? 'Értesítések beállítása…' : 'Push értesítések engedélyezése'}
              </button>
              {pushMessage && <p className="muted">{pushMessage}</p>}
            </div>
          )}


          {setupComplete === true && (
            <section className="confirmation">
              <p className="eyebrow">Reggeli briefing</p>
              <div className="stack compact-stack">
                <label className="inline-control">
                  <input
                    type="checkbox"
                    checked={briefingEnabled}
                    onChange={(event) => setBriefingEnabled(event.target.checked)}
                  />
                  Kérek napi reggeli összefoglalót
                </label>

                <label>
                  Briefing időpontja
                  <input
                    type="time"
                    value={briefingTime}
                    onChange={(event) => setBriefingTime(event.target.value)}
                    disabled={!briefingEnabled}
                  />
                </label>

                <div className="actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={handleSaveBriefingSettings}
                    disabled={settingsBusy || !settingsLoaded}
                  >
                    {settingsBusy ? 'Mentés…' : 'Briefing beállítás mentése'}
                  </button>
                </div>

                {settingsMessage && <p className="muted">{settingsMessage}</p>}
              </div>
            </section>
          )}

          {setupComplete === false && pendingOwnerInvitation && (
            <form className="stack" onSubmit={handleAcceptOwnerInvitation}>
              <h2>Ügygazda-meghívás elfogadása</h2>
              <p className="muted">
                Meghívást kaptál${invitationFamilyName ? ` a(z) ${invitationFamilyName} családhoz` : ''}.
                Válassz egy nevet, amelyen a családi asszisztensben szerepelni szeretnél.
              </p>

              <label>
                Megjelenített név / alias
                <input
                  value={inviteDisplayName}
                  onChange={(event) => setInviteDisplayName(event.target.value)}
                  placeholder="Például: Anya"
                  required
                />
              </label>

              <label>
                Jelszó
                <input
                  type="password"
                  value={invitePassword}
                  onChange={(event) => setInvitePassword(event.target.value)}
                  placeholder="Legalább 6 karakter"
                  minLength={6}
                  required
                />
              </label>

              <button className="primary-button" type="submit" disabled={flowBusy}>
                {flowBusy ? 'Csatlakozás…' : 'Meghívás elfogadása'}
              </button>
            </form>
          )}

          {setupComplete === false && !pendingOwnerInvitation && (
            <form className="stack" onSubmit={handleBootstrap}>
              <h2>Első család beállítása</h2>

              <label>
                Család neve
                <input value={familyName} onChange={(event) => setFamilyName(event.target.value)} required />
              </label>

              <label>
                A te neved
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
              </label>

              <label>
                Második ügygazda e-mailje (opcionális)
                <input
                  type="email"
                  value={secondOwnerEmail}
                  onChange={(event) => setSecondOwnerEmail(event.target.value)}
                  placeholder="pelda@email.hu"
                />
              </label>

              <label>
                Érintett családtagok
                <input
                  value={managedMembersText}
                  onChange={(event) => setManagedMembersText(event.target.value)}
                  placeholder="Bence, Mamus"
                />
                <span className="muted">Vesszővel válaszd el őket. Ők nem kapnak hozzáférést a rendszerhez.</span>
              </label>

              <button className="primary-button" type="submit" disabled={flowBusy}>
                {flowBusy ? 'Mentés…' : 'Család létrehozása'}
              </button>
            </form>
          )}

          {setupComplete === true && (
            <div className="stack">
              {familyStructure && (
                <section className="confirmation">
                  <p className="eyebrow">Ügygazdák</p>
                  <p>
                    {familyStructure.owners.map((owner) =>
                      owner.is_current_user ? `${owner.display_name} (te)` : owner.display_name
                    ).join(', ')}
                  </p>

                  {familyStructure.pending_second_owner_invitation && (
                    <p className="muted">A második ügygazda meghívása elküldve, elfogadásra vár.</p>
                  )}

                  {familyStructure.can_invite_second_owner && (
                    <form className="stack compact-stack" onSubmit={handleInviteSecondOwner}>
                      <label>
                        Második ügygazda e-mailje
                        <input
                          type="email"
                          value={ownerInviteEmail}
                          onChange={(event) => setOwnerInviteEmail(event.target.value)}
                          placeholder="pelda@email.hu"
                          required
                        />
                      </label>
                      <button className="secondary-button" type="submit" disabled={ownerInviteBusy}>
                        {ownerInviteBusy ? 'Meghívás…' : 'Második ügygazda meghívása'}
                      </button>
                    </form>
                  )}

                  {ownerInviteMessage && <p className="muted">{ownerInviteMessage}</p>}
                </section>
              )}

              <div className="auth-tabs" aria-label="Művelet">
                <button
                  className={workMode === 'create' ? 'tab active' : 'tab'}
                  type="button"
                  onClick={() => {
                    setWorkMode('create')
                    setDraft(null)
                    setUpdateDraft(null)
                    setUpdateCandidates([])
                    setUpdateChanges(null)
                    setQueryAnswer(null)
                    setFlowError(null)
                    setFlowMessage(null)
                  }}
                >
                  Új ügy
                </button>
                <button
                  className={workMode === 'update' ? 'tab active' : 'tab'}
                  type="button"
                  onClick={() => {
                    setWorkMode('update')
                    setDraft(null)
                    setUpdateDraft(null)
                    setUpdateCandidates([])
                    setUpdateChanges(null)
                    setCompleteDraft(null)
                    setCompleteCandidates([])
                    setQueryAnswer(null)
                    setFlowError(null)
                    setFlowMessage(null)
                  }}
                >
                  Módosítás
                </button>
                <button
                  className={workMode === 'complete' ? 'tab active' : 'tab'}
                  type="button"
                  onClick={() => {
                    setWorkMode('complete')
                    setDraft(null)
                    setUpdateDraft(null)
                    setUpdateCandidates([])
                    setUpdateChanges(null)
                    setCompleteDraft(null)
                    setCompleteCandidates([])
                    setQueryAnswer(null)
                    setFlowError(null)
                    setFlowMessage(null)
                  }}
                >
                  Kész
                </button>
                <button
                  className={workMode === 'query' ? 'tab active' : 'tab'}
                  type="button"
                  onClick={() => {
                    setWorkMode('query')
                    setDraft(null)
                    setReminderFollowupOpen(false)
                    setReminderFollowupText('')
                    setUpdateDraft(null)
                    setUpdateCandidates([])
                    setUpdateChanges(null)
                    setCompleteDraft(null)
                    setCompleteCandidates([])
                    setQueryAnswer(null)
                    setFlowError(null)
                    setFlowMessage(null)
                  }}
                >
                  Keresés
                </button>
              </div>

              <form className="stack" onSubmit={handleInterpret}>
                <h2>
                  {workMode === 'create'
                    ? 'Új ügy rögzítése'
                    : workMode === 'update'
                      ? 'Meglévő ügy módosítása'
                      : workMode === 'complete'
                        ? 'Ügy készre jelölése'
                        : 'Keresés és előzmények'}
                </h2>
                <p className="muted">
                  {workMode === 'create'
                    ? 'Írd le természetesen, mit kell észben tartani.'
                    : workMode === 'update'
                      ? 'Írd le természetesen, mit szeretnél módosítani.'
                      : workMode === 'complete'
                        ? 'Írd le természetesen, mit intéztél el.'
                        : 'Kérdezz rá a nyitott ügyekre vagy a korábbi, elintézett bejegyzésekre.'}
                </p>

                <textarea
                  rows={5}
                  value={naturalMessage}
                  onChange={(event) => setNaturalMessage(event.target.value)}
                  placeholder={
                    workMode === 'create'
                      ? 'Bencének jövő kedden 16:30-kor fogorvosa van, három nappal előtte szólj.'
                      : workMode === 'update'
                        ? 'Anya fodrászát áttették jövő keddre 11-re.'
                        : workMode === 'complete'
                          ? 'A biztosítást befizettem.'
                          : 'Mi van holnap? / Mikor megy Anya fodrászhoz? / Mit intéztem el ezen a héten?'
                  }
                  required
                />

                <button className="primary-button" type="submit" disabled={flowBusy}>
                  {flowBusy
                    ? workMode === 'query' ? 'Keresés…' : 'Értelmezés…'
                    : workMode === 'query' ? 'Keresés' : 'Értelmezés'}
                </button>
              </form>

              {queryAnswer && (
                <section className="confirmation">
                  <p className="eyebrow">Találatok</p>
                  <p className="query-answer">{queryAnswer}</p>
                </section>
              )}

              {draft && (
                <section className="confirmation">
                  <p className="eyebrow">Visszaigazolás</p>
                  <p>{draft.confirmation_text}</p>
                  <div className="actions">
                    <button className="primary-button" type="button" onClick={handleConfirmCreate} disabled={flowBusy}>
                      Igen, rögzítsd
                    </button>
                    {!draft.first_reminder_at && draft.due_date && !reminderFollowupOpen && (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => {
                          setReminderFollowupOpen(true)
                          setReminderFollowupText('')
                          setFlowError(null)
                        }}
                        disabled={flowBusy}
                      >
                        Korábban is szólj
                      </button>
                    )}
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => {
                        setDraft(null)
                        setReminderFollowupOpen(false)
                        setReminderFollowupText('')
                      }}
                      disabled={flowBusy}
                    >
                      Mégse
                    </button>
                  </div>

                  {reminderFollowupOpen && !draft.first_reminder_at && draft.due_date && (
                    <div className="stack compact-stack">
                      <label>
                        Mikor szóljak előtte?
                        <input
                          type="text"
                          value={reminderFollowupText}
                          onChange={(event) => setReminderFollowupText(event.target.value)}
                          placeholder="Például: egy nappal előtte"
                        />
                      </label>
                      <div className="actions">
                        <button
                          className="primary-button"
                          type="button"
                          onClick={handleAddCreateReminder}
                          disabled={flowBusy || !reminderFollowupText.trim()}
                        >
                          Emlékeztető beállítása
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => {
                            setReminderFollowupOpen(false)
                            setReminderFollowupText('')
                          }}
                          disabled={flowBusy}
                        >
                          Mégse
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {updateCandidates.length > 0 && (
                <section className="confirmation">
                  <p className="eyebrow">Több lehetséges ügyet találtam</p>
                  <p>Melyikre gondoltál?</p>
                  <div className="candidate-list">
                    {updateCandidates.map((candidate) => (
                      <button
                        className="secondary-button candidate-button"
                        type="button"
                        key={candidate.id}
                        onClick={() => handleChooseUpdateTarget(candidate.id)}
                        disabled={flowBusy}
                      >
                        {candidate.label}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {updateDraft && (
                <section className="confirmation">
                  <p className="eyebrow">Módosítás visszaigazolása</p>
                  <p>{updateDraft.confirmation_text}</p>
                  <div className="actions">
                    <button className="primary-button" type="button" onClick={handleConfirmUpdate} disabled={flowBusy}>
                      Igen, módosítsd
                    </button>
                    <button className="secondary-button" type="button" onClick={handleCancelUpdate} disabled={flowBusy}>
                      Mégse
                    </button>
                  </div>
                </section>
              )}


              {completeCandidates.length > 0 && (
                <section className="confirmation">
                  <p className="eyebrow">Több lehetséges ügyet találtam</p>
                  <p>Melyiket intézted el?</p>
                  <div className="candidate-list">
                    {completeCandidates.map((candidate) => (
                      <button
                        className="secondary-button candidate-button"
                        type="button"
                        key={candidate.id}
                        onClick={() => handleChooseCompleteTarget(candidate.id)}
                        disabled={flowBusy}
                      >
                        {candidate.label}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {completeDraft && (
                <section className="confirmation">
                  <p className="eyebrow">Lezárás visszaigazolása</p>
                  <p>{completeDraft.confirmation_text}</p>
                  <div className="actions">
                    <button className="primary-button" type="button" onClick={handleConfirmComplete} disabled={flowBusy}>
                      Igen, kész
                    </button>
                    <button className="secondary-button" type="button" onClick={handleCancelComplete} disabled={flowBusy}>
                      Mégse
                    </button>
                  </div>
                </section>
              )}
            </div>
          )}

          {setupComplete === null && <p>Core kapcsolat ellenőrzése…</p>}
          {flowMessage && <p className="notice success">{flowMessage}</p>}
          {flowError && <p className="notice error">{flowError}</p>}
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
