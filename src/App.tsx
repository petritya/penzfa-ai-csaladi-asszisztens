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

type OpenItem = {
  id: string
  title: string
  item_type: 'task' | 'event' | 'deadline'
  due_date: string | null
  due_time: string | null
  subject_member_id: string | null
  responsible_user_id: string | null
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
  const [familyId, setFamilyId] = useState<string | null>(null)
  const [familyName, setFamilyName] = useState<string | null>(null)
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([])
  const [familyError, setFamilyError] = useState<string | null>(null)

  const [openItems, setOpenItems] = useState<OpenItem[]>([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsError, setItemsError] = useState<string | null>(null)
  const [itemsRefreshKey, setItemsRefreshKey] = useState(0)

  const [createMessage, setCreateMessage] = useState('')
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createSuccess, setCreateSuccess] = useState<string | null>(null)

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
      setFamilyId(null)
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

      setFamilyId(familyId)
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
  }, [session])

  useEffect(() => {
    const client = supabase

    if (!client || !session || !familyId) {
      setOpenItems([])
      setItemsError(null)
      return
    }

    let cancelled = false

    async function loadOpenItems(activeClient: NonNullable<typeof supabase>) {
      setItemsLoading(true)
      setItemsError(null)

      const { data, error } = await activeClient
        .from('items')
        .select('id, title, item_type, due_date, due_time, subject_member_id, responsible_user_id')
        .eq('family_id', familyId)
        .eq('status', 'open')
        .order('due_date', { ascending: true, nullsFirst: false })
        .order('due_time', { ascending: true, nullsFirst: false })
        .limit(50)

      if (cancelled) return

      if (error) {
        setItemsError(error.message)
        setOpenItems([])
        setItemsLoading(false)
        return
      }

      setOpenItems((data ?? []) as OpenItem[])
      setItemsLoading(false)
    }

    loadOpenItems(client)

    return () => {
      cancelled = true
    }
  }, [session, familyId, itemsRefreshKey])

  function formatItemDate(item: OpenItem) {
    if (!item.due_date) return 'Nincs dátum'

    const [year, month, day] = item.due_date.split('-').map(Number)
    const date = new Date(Date.UTC(year, month - 1, day))
    const dateText = new Intl.DateTimeFormat('hu-HU', {
      month: 'long',
      day: 'numeric',
      weekday: 'short',
      timeZone: 'UTC',
    }).format(date)

    return item.due_time
      ? `${dateText} ${String(item.due_time).slice(0, 5)}`
      : dateText
  }

  function itemTypeLabel(itemType: OpenItem['item_type']) {
    if (itemType === 'event') return 'Esemény'
    if (itemType === 'deadline') return 'Határidő'
    return 'Teendő'
  }

  async function handleInterpretCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return

    const message = createMessage.trim()
    if (!message) return

    setCreateBusy(true)
    setCreateDraft(null)
    setCreateError(null)
    setCreateSuccess(null)

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
      setItemsRefreshKey((value) => value + 1)
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
    setCreateError(null)
    setCreateSuccess(null)
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

          {!familyLoading && familyName && (
            <section className="family-block" aria-label="Családtagok">
              <h2>Családtagok</h2>
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
            </section>
          )}

          {familyName && (
            <section className="items-block" aria-label="Nyitott ügyek">
              <div className="section-heading">
                <h2>Nyitott ügyek</h2>
                {!itemsLoading && <span>{openItems.length}</span>}
              </div>

              {itemsLoading && <p className="muted">Ügyek betöltése…</p>}
              {itemsError && <p className="notice error">{itemsError}</p>}

              {!itemsLoading && !itemsError && openItems.length === 0 && (
                <p className="empty-state">Nincs nyitott ügy.</p>
              )}

              {!itemsLoading && openItems.length > 0 && (
                <ul className="item-list">
                  {openItems.map((item) => {
                    const subject = familyMembers.find((member) => member.id === item.subject_member_id)
                    const responsible = familyMembers.find(
                      (member) => member.user_id && member.user_id === item.responsible_user_id,
                    )

                    return (
                      <li key={item.id}>
                        <div className="item-main">
                          <strong>{item.title}</strong>
                          <span>{formatItemDate(item)}</span>
                        </div>
                        <div className="item-meta">
                          <span>{itemTypeLabel(item.item_type)}</span>
                          {subject && <span>{subject.display_name}</span>}
                          {responsible && <span>Ügygazda: {responsible.display_name}</span>}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )}

          {familyName && (
            <section className="capture-block" aria-label="Új ügy rögzítése">
              <h2>Új ügy</h2>
              <p className="capture-help">
                Írd be vagy diktáld természetesen. Például: „Mamusnak jövő kedden 10-kor kontroll.”
              </p>

              <form className="capture-form" onSubmit={handleInterpretCreate}>
                <textarea
                  value={createMessage}
                  onChange={(event) => {
                    setCreateMessage(event.target.value)
                    setCreateDraft(null)
                    setCreateError(null)
                    setCreateSuccess(null)
                  }}
                  placeholder="Mit jegyezzek meg?"
                  rows={3}
                  disabled={createBusy}
                />

                <button
                  className="primary-button"
                  type="submit"
                  disabled={createBusy || !createMessage.trim()}
                >
                  {createBusy ? 'Feldolgozás…' : 'Értelmezés'}
                </button>
              </form>

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

          <dl className="account">
            <div>
              <dt>Belépett fiók</dt>
              <dd>{session.user.email ?? 'Ismeretlen e-mail'}</dd>
            </div>
          </dl>

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
