import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

// Időzített, csak új és kifejezetten engedélyezett egész napos ügyekhez.
// Az automatika SOHA nem adhat allow_resend engedélyt, a tartós exportnapló mindig elsőbbséget élvez.
const url = Deno.env.get('SUPABASE_URL') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const clientId = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID') ?? ''
const clientSecret = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET') ?? ''

type Pending = {
  user_id: string
  item_id: string
  event_title: string
  event_notes: string | null
  event_date: string
  event_time: string | null
  event_timezone: string
  event_created_at: string
  event_updated_at: string
  encrypted_refresh_token: string
}

function json(data: unknown, code = 200): Response {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

async function decryptRefreshToken(value: string): Promise<string> {
  const bytes = Uint8Array.from(atob(value), (s) => s.charCodeAt(0))
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(clientSecret), 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new TextEncoder().encode('penzfa-google-calendar-oauth-2026'),
    info: new TextEncoder().encode('refresh-token-encryption-v1'),
  }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12))
  return new TextDecoder().decode(plain)
}

async function deterministicId(userId: string, itemId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode('penzfa-calendar-v1:' + userId + ':' + itemId),
  ))
  return 'a' + Array.from(digest).map((v) => v.toString(16).padStart(2, '0')).join('')
}

function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}


function calendarEventWindow(date: string, time: string | null, timeZone: string) {
  if (!time) return {
    start: { date },
    end: { date: nextDate(date) },
  }
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('Invalid local event time')
  }
  const desired = Date.UTC(year, month - 1, day, hour, minute)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  let instant = desired
  for (let i = 0; i < 4; i++) {
    const values = Object.fromEntries(
      formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
    )
    const represented = Date.UTC(
      Number(values.year), Number(values.month) - 1, Number(values.day),
      Number(values.hour), Number(values.minute),
    )
    if (represented === desired) break
    instant += desired - represented
  }
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  )
  const represented = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute),
  )
  if (represented !== desired) throw new Error('Nonexistent time during timezone change')
  return {
    start: { dateTime: new Date(instant).toISOString(), timeZone },
    end: { dateTime: new Date(instant + 60 * 60_000).toISOString(), timeZone },
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Csak POST kérés.' }, 405)
  if (!url || !serviceKey || !clientId || !clientSecret) {
    return json({ error: 'Hiányzó szerverkonfiguráció.' }, 503)
  }
  // A Supabase Gateway előbb ellenőrzi a JWT-t (verify_jwt=true).
  // A projekt Vault-ban lévő cron JWT eltérhet az Edge belső SUPABASE_ANON_KEY értékétől.
  // Nem szabad ezeket bájtról bájtra összehasonlítani.
  if (!req.headers.get('Authorization')?.startsWith('Bearer ')) {
    return json({ error: 'Hiányzó időzítő-hitelesítés.' }, 401)
  }
  const body = await req.json().catch(() => ({})) as { source?: string }
  if (body.source !== 'cron') return json({ error: 'Nem időzített kérés.' }, 400)

  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // A nem titkos anon kulcs ismeretében sem lehet a feladatot korlátlanul újraindítani.
  const now = new Date()
  const { data: claim, error: claimError } = await db.from('google_calendar_auto_runs')
    .update({ last_run_at: now.toISOString() })
    .eq('id', 1)
    .lte('last_run_at', new Date(now.getTime() - 4 * 60_000).toISOString())
    .select('id')
    .maybeSingle()
  if (claimError) return json({ error: 'Időzítési hiba.' }, 500)
  if (!claim) return json({ status: 'skipped', reason: 'recent_run' })

  const { data: pending, error: scanError } = await db.rpc('google_calendar_pending_auto_exports', { p_limit: 5 })
  if (scanError) return json({ error: 'Naptár-küldési lista nem elérhető.' }, 500)

  async function sendOne(row: Pending): Promise<'sent' | 'skipped' | 'failed'> {
    try {
      // Ha a felhasználó időközben kikapcsolta, az ügy lezárult vagy megváltozott:
      // már ne menjen ki a korábbi állapot alapján.
      const [{ data: connection }, { data: current }] = await Promise.all([
        db.from('google_calendar_connections')
          .select('auto_export_enabled_at, auto_export_error').eq('user_id', row.user_id).maybeSingle(),
        db.from('items')
          .select('updated_at, created_at, status, due_date, due_time, responsible_user_id')
          .eq('id', row.item_id).maybeSingle(),
      ])
      if (!connection?.auto_export_enabled_at || connection.auto_export_error
        || !current || current.status !== 'open'
        || current.due_time !== row.event_time || current.due_date !== row.event_date
        || current.responsible_user_id !== row.user_id
        || new Date(current.created_at).getTime() < new Date(connection.auto_export_enabled_at).getTime()
        || new Date(current.updated_at).getTime() !== new Date(row.event_updated_at).getTime()) {
        return 'skipped'
      }

      const token = await decryptRefreshToken(row.encrypted_refresh_token)
      const refresh = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: token,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (!refresh.ok) {
        const failure = await refresh.json().catch(() => ({})) as { error?: string }
        if (failure.error === 'invalid_grant') {
          // A Google OAuth Testing mód tokenje lejárhat. Ne próbálkozzunk
          // minden öt percben és ne küldjünk újabb értesítés nélküli eseményeket.
          await db.from('google_calendar_connections')
            .update({ auto_export_enabled_at: null, auto_export_error: 'reauthorize_required' })
            .eq('user_id', row.user_id).eq('refresh_token_encrypted', row.encrypted_refresh_token)
        }
        return 'failed'
      }
      const tokenBody = await refresh.json() as { access_token?: string }
      if (!tokenBody.access_token) return 'failed'

      const eventId = await deterministicId(row.user_id, row.item_id)
      // Időzóna és helyi időpont ellenőrzése még a foglalás és Google API előtt.
      const eventWindow = calendarEventWindow(row.event_date, row.event_time, row.event_timezone)
      // A legkorábbi foglalás nyer; ha korábban bármilyen kiküldési kísérlet
      // volt, semmiképp nem indítjuk újra automatikusan.
      const { error: reservation } = await db.from('google_calendar_exports').insert({
        user_id: row.user_id, item_id: row.item_id, event_id: eventId, status: 'sending',
      })
      if (reservation?.code === '23505') return 'skipped'
      if (reservation) return 'failed'

      const created = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + tokenBody.access_token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: eventId,
          summary: row.event_title,
          description: row.event_notes ?? '',
          ...eventWindow,
          visibility: 'private',
          reminders: { useDefault: false },
          extendedProperties: { private: { penzfa_item_id: row.item_id } },
        }),
        signal: AbortSignal.timeout(10000),
      })
      if (!created.ok && created.status !== 409) {
        // Nem történt létrehozás: explicit klienshiba esetén törölhető a foglalás.
        // Bizonytalan hálózati/szerverhibánál szándékosan 'sending' marad.
        if ([400, 401, 403, 404, 429].includes(created.status)) {
          await db.from('google_calendar_exports').delete()
            .eq('user_id', row.user_id).eq('item_id', row.item_id).eq('status', 'sending')
        }
        return 'failed'
      }
      if (created.status !== 409) {
        const event = await created.json() as { id?: string }
        if (event.id !== eventId) return 'failed'
      }

      const { data: saved, error: saveError } = await db.from('google_calendar_exports')
        .update({ status: 'sent', exported_at: new Date().toISOString() })
        .eq('user_id', row.user_id).eq('item_id', row.item_id)
        .eq('event_id', eventId).eq('status', 'sending')
        .select('item_id').maybeSingle()
      return saveError || !saved ? 'failed' : 'sent'
    } catch {
      // Nincs automatikus újraküldés, ha a hálózati válasz bizonytalan.
      return 'failed'
    }
  }


  // Meglévő Google-esemény módosítása; soha nem hozunk létre új eseményt.
  // A lezárás csak egy nyelvfüggő "Elvégezve"/"Udført" sort ír a leírásba.
  // ETag + egyszeri állapotfoglalás védi a párhuzamos és Google-oldali módosításokat.
  type ExistingLink = {
    user_id: string; item_id: string; event_id: string; exported_at: string;
    sync_local_updated_at: string | null; sync_google_etag: string | null;
    sync_status: string;
  }
  async function updateExisting(link: ExistingLink): Promise<'sent' | 'skipped' | 'conflict' | 'failed'> {
    const [{ data: item }, { data: connection }, { data: settings }, { data: member }] = await Promise.all([
      db.from('items').select('id,family_id,title,notes,due_date,due_time,status,updated_at,responsible_user_id')
        .eq('id', link.item_id).maybeSingle(),
      db.from('google_calendar_connections')
        .select('refresh_token_encrypted,auto_export_enabled_at,auto_export_error')
        .eq('user_id', link.user_id).maybeSingle(),
      db.from('user_settings').select('timezone,ui_locale').eq('user_id', link.user_id).maybeSingle(),
      db.from('family_members').select('family_id').eq('user_id', link.user_id)
        .eq('member_kind','active').maybeSingle(),
    ])
    if (!item || !member || member.family_id !== item.family_id
      || item.responsible_user_id !== link.user_id
      || (item.status !== 'open' && item.status !== 'done')
      || !connection?.auto_export_enabled_at || connection.auto_export_error
      || !connection.refresh_token_encrypted) return 'skipped'
    const baseline = link.sync_local_updated_at ?? link.exported_at
    if (!baseline || Date.parse(item.updated_at) <= Date.parse(baseline)) return 'skipped'
    if (item.status === 'open' && !item.due_date) return 'skipped'

    // Az első munka foglalása atomikus; bizonytalan hálózati hiba nem
    // vált ki második automatikus Google-módosítást.
    const { data: locked, error: lockError } = await db.from('google_calendar_exports')
      .update({ sync_status: 'syncing', sync_attempted_at: new Date().toISOString(), sync_error: null })
      .eq('user_id', link.user_id).eq('item_id', link.item_id)
      .eq('status', 'sent').eq('sync_status', link.sync_status)
      .select('item_id').maybeSingle()
    if (lockError || !locked) return 'skipped'
    async function finish(status: string, error: string | null, etag?: string) {
      const values: Record<string, unknown> = { sync_status: status, sync_error: error }
      if (status === 'synced') {
        values.sync_local_updated_at = item.updated_at
        if (etag) values.sync_google_etag = etag
      }
      await db.from('google_calendar_exports').update(values)
        .eq('user_id', link.user_id).eq('item_id', link.item_id).eq('sync_status', 'syncing')
    }
    try {
      const refreshToken = await decryptRefreshToken(connection.refresh_token_encrypted)
      const refresh = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret,
          refresh_token: refreshToken, grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (!refresh.ok) {
        const err = await refresh.json().catch(() => ({})) as { error?: string }
        if (err.error === 'invalid_grant') {
          await db.from('google_calendar_connections')
            .update({ auto_export_enabled_at: null, auto_export_error: 'reauthorize_required' })
            .eq('user_id', link.user_id)
            .eq('refresh_token_encrypted', connection.refresh_token_encrypted)
        }
        await finish('error', err.error === 'invalid_grant' ? 'reauthorize_required' : 'google_auth_failed')
        return 'failed'
      }
      const accessToken = (await refresh.json() as { access_token?: string }).access_token
      if (!accessToken) { await finish('error', 'missing_google_token'); return 'failed' }
      const endpoint = 'https://www.googleapis.com/calendar/v3/calendars/primary/events/'
        + encodeURIComponent(link.event_id)
      const remoteResponse = await fetch(endpoint, {
        headers: { Authorization: 'Bearer ' + accessToken },
        signal: AbortSignal.timeout(10000),
      })
      if (remoteResponse.status === 404 || remoteResponse.status === 410) {
        await finish('conflict', 'google_event_deleted')
        return 'conflict'
      }
      if (!remoteResponse.ok) {
        await finish('error', 'google_read_http_' + remoteResponse.status)
        return 'failed'
      }
      const remote = await remoteResponse.json() as {
        id?: string; etag?: string; status?: string; updated?: string;
        summary?: string; description?: string;
        recurringEventId?: string; recurrence?: string[];
        start?: { date?: string; dateTime?: string };
        end?: { date?: string; dateTime?: string };
      }
      if (remote.id !== link.event_id || !remote.etag || remote.status === 'cancelled'
        || remote.recurringEventId || remote.recurrence?.length) {
        await finish('conflict', 'unsupported_or_changed_google_event')
        return 'conflict'
      }

      const changes: Record<string, unknown> = {}
      if (item.status === 'done') {
        const marker = settings?.ui_locale === 'da-DK' ? 'Udført' : 'Elvégezve'
        const before = String(remote.description ?? '')
        const hasMarker = before.split(/\r?\n/).some(line =>
          line.trim() === 'Elvégezve' || line.trim() === 'Udført')
        if (!hasMarker) changes.description = (before.trimEnd()
          ? before.trimEnd() + '\n' : '') + marker
      } else {
        if (remote.summary !== item.title) changes.summary = item.title
        const desiredNotes = item.notes ?? ''
        if ((remote.description ?? '') !== desiredNotes) changes.description = desiredNotes
        const target = calendarEventWindow(item.due_date, item.due_time, settings?.timezone || 'Europe/Budapest')
        const newStart = target.start as { date?: string; dateTime?: string; timeZone?: string }
        const previousStart = remote.start
        const sameStart = newStart.date
          ? remote.start?.date === newStart.date && !remote.start?.dateTime
          : Boolean(remote.start?.dateTime && newStart.dateTime
            && Date.parse(remote.start.dateTime) === Date.parse(newStart.dateTime))
        if (!sameStart) {
          changes.start = newStart
          if (newStart.date) {
            const oldStart = Date.parse(remote.start?.date ?? '')
            const oldEnd = Date.parse(remote.end?.date ?? '')
            const days = Number.isFinite(oldStart) && Number.isFinite(oldEnd)
              ? Math.round((oldEnd - oldStart) / 86400000) : 1
            changes.end = {
              date: nextDateByDays(newStart.date, days >= 1 && days <= 365 ? days : 1),
            }
          } else {
            const oldStart = Date.parse(remote.start?.dateTime ?? '')
            const oldEnd = Date.parse(remote.end?.dateTime ?? '')
            const duration = oldEnd - oldStart
            const minutes = Number.isFinite(duration) && duration >= 60000 && duration <= 30 * 86400000
              ? duration : 3600000
            changes.end = {
              dateTime: new Date(Date.parse(newStart.dateTime!) + minutes).toISOString(),
              timeZone: newStart.timeZone,
            }
          }
        }
      }
      // Azonos állapot esetén új PATCH nem szükséges, csak a napló frissül.
      if (Object.keys(changes).length === 0) {
        await finish('synced', null, remote.etag)
        return 'sent'
      }
      // Ismeretlen kezdeti ETag esetén a Google távoli módosításának idejét
      // hasonlítjuk az utolsó ismert export időpontjához.
      const editedInGoogle = link.sync_google_etag
        ? link.sync_google_etag !== remote.etag
        : (Boolean(remote.updated) && Date.parse(remote.updated!) > Date.parse(link.exported_at) + 30000)
      if (editedInGoogle) {
        await finish('conflict', 'google_changed_since_last_sync')
        return 'conflict'
      }

      // Ha az ügy közben megváltozott, az elavult állapotot nem írjuk ki.
      const { data: current } = await db.from('items')
        .select('updated_at,status').eq('id', item.id).maybeSingle()
      if (!current || current.updated_at !== item.updated_at || current.status !== item.status) {
        await finish('synced', null, remote.etag)
        // A legújabb verzió továbbra is újraellenőrizhető.
        return 'skipped'
      }
      const updated = await fetch(endpoint + '?sendUpdates=none', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
          'If-Match': remote.etag,
        },
        body: JSON.stringify(changes),
        signal: AbortSignal.timeout(10000),
      })
      if (updated.status === 412) {
        await finish('conflict', 'google_changed_during_sync')
        return 'conflict'
      }
      if (updated.status === 404 || updated.status === 410) {
        await finish('conflict', 'google_event_deleted')
        return 'conflict'
      }
      if (!updated.ok) {
        await finish('error', 'google_write_http_' + updated.status)
        return 'failed'
      }
      const confirmed = await updated.json() as { id?: string; etag?: string }
      if (confirmed.id !== link.event_id || !confirmed.etag) {
        await finish('error', 'google_response_uncertain')
        return 'failed'
      }
      await finish('synced', null, confirmed.etag)
      return 'sent'
    } catch (error) {
      // A PATCH kimenetele hálózati hibánál lehet bizonytalan:
      // kézi vizsgálatig ne próbálkozzunk újból.
      await finish('error', 'network_result_uncertain')
      console.warn('Google Calendar update needs review', error)
      return 'failed'
    }
  }

  function nextDateByDays(date: string, days: number): string {
    const [y, m, d] = date.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
  }

  const { data: linked, error: linkedError } = await db.from('google_calendar_exports')
    .select('user_id,item_id,event_id,exported_at,sync_local_updated_at,sync_google_etag,sync_status')
    .eq('status','sent').in('sync_status',['idle','synced'])
    .order('first_attempted_at',{ascending:true}).limit(100)
  if (linkedError) return json({ error: 'Meglévő naptárkapcsolatok vizsgálata nem sikerült.' }, 500)
  const updateResults = await Promise.all(
    ((linked ?? []) as ExistingLink[]).map(link => updateExisting(link))
  )

  const results = await Promise.all((pending as Pending[] ?? []).map((row) => sendOne(row)))
  return json({
    status: 'ok',
    inspected: results.length,
    sent: results.filter((v) => v === 'sent').length,
    skipped: results.filter((v) => v === 'skipped').length,
    failed: results.filter((v) => v === 'failed').length,
    updated: updateResults.filter((v) => v === 'sent').length,
    update_conflicts: updateResults.filter((v) => v === 'conflict').length,
    update_failed: updateResults.filter((v) => v === 'failed').length,
  })
})
