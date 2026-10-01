import { FormEvent, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'

type AuthMode = 'sign-in' | 'sign-up'
type WorkMode = 'create' | 'update'

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
  const [managedMembersText, setManagedMembersText] = useState('Bence, Anyu')
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null)

  const [workMode, setWorkMode] = useState<WorkMode>('create')
  const [naturalMessage, setNaturalMessage] = useState('')
  const [draft, setDraft] = useState<CreateDraft | null>(null)
  const [updateDraft, setUpdateDraft] = useState<UpdateDraft | null>(null)
  const [updateCandidates, setUpdateCandidates] = useState<UpdateCandidate[]>([])
  const [updateChanges, setUpdateChanges] = useState<UpdateChanges | null>(null)
  const [flowMessage, setFlowMessage] = useState<string | null>(null)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [flowBusy, setFlowBusy] = useState(false)

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
      setDraft(null)
      setUpdateDraft(null)
      setUpdateCandidates([])
      setUpdateChanges(null)
      setFlowMessage(null)
      setFlowError(null)
    })

    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session || setupComplete !== null) return

    void invokeCore({ action: 'setup_status' })
      .then((data) => setSetupComplete(Boolean(data.setup_complete)))
      .catch(() => setSetupComplete(false))
  }, [session, setupComplete])

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
    const { error } = await supabase.auth.signOut()

    if (error) setErrorMessage(error.message)
  }

  async function handleBootstrap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFlowBusy(true)
    setFlowError(null)
    setFlowMessage(null)

    try {
      await invokeCore({
        action: 'bootstrap',
        family_name: familyName.trim(),
        display_name: displayName.trim(),
        managed_members: managedMembers,
      })
      setSetupComplete(true)
      setFlowMessage('A család alapadatai elkészültek.')
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Nem sikerült létrehozni a családot.')
    } finally {
      setFlowBusy(false)
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

    try {
      const data = await invokeCore({
        action: workMode === 'create' ? 'interpret_create' : 'interpret_update',
        message: naturalMessage.trim(),
      })

      if (workMode === 'create') {
        setDraft(data.draft as CreateDraft)
        return
      }

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

      setFlowMessage(`Rögzítve: ${data.item.title}`)
      setNaturalMessage('')
      setDraft(null)
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Nem sikerült rögzíteni a bejegyzést.')
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

          {setupComplete === false && (
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
                Kezelt családtagok
                <input
                  value={managedMembersText}
                  onChange={(event) => setManagedMembersText(event.target.value)}
                  placeholder="Bence, Anyu"
                />
              </label>

              <button className="primary-button" type="submit" disabled={flowBusy}>
                {flowBusy ? 'Mentés…' : 'Család létrehozása'}
              </button>
            </form>
          )}

          {setupComplete === true && (
            <div className="stack">
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
                    setFlowError(null)
                    setFlowMessage(null)
                  }}
                >
                  Módosítás
                </button>
              </div>

              <form className="stack" onSubmit={handleInterpret}>
                <h2>{workMode === 'create' ? 'Új ügy rögzítése' : 'Meglévő ügy módosítása'}</h2>
                <p className="muted">
                  {workMode === 'create'
                    ? 'Írd le természetesen, mit kell észben tartani.'
                    : 'Írd le természetesen, mit szeretnél módosítani.'}
                </p>

                <textarea
                  rows={5}
                  value={naturalMessage}
                  onChange={(event) => setNaturalMessage(event.target.value)}
                  placeholder={
                    workMode === 'create'
                      ? 'Bencének jövő kedden 16:30-kor fogorvosa van, három nappal előtte szólj.'
                      : 'Anya fodrászát áttették jövő keddre 11-re.'
                  }
                  required
                />

                <button className="primary-button" type="submit" disabled={flowBusy}>
                  {flowBusy ? 'Értelmezés…' : 'Értelmezés'}
                </button>
              </form>

              {draft && (
                <section className="confirmation">
                  <p className="eyebrow">Visszaigazolás</p>
                  <p>{draft.confirmation_text}</p>
                  <div className="actions">
                    <button className="primary-button" type="button" onClick={handleConfirmCreate} disabled={flowBusy}>
                      Igen, rögzítsd
                    </button>
                    <button className="secondary-button" type="button" onClick={() => setDraft(null)} disabled={flowBusy}>
                      Mégse
                    </button>
                  </div>
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
