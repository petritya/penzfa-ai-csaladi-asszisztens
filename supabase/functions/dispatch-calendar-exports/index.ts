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
        || current.due_time !== null || current.due_date !== row.event_date
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
          start: { date: row.event_date },
          end: { date: nextDate(row.event_date) },
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

  const results = await Promise.all((pending as Pending[] ?? []).map((row) => sendOne(row)))
  return json({
    status: 'ok',
    inspected: results.length,
    sent: results.filter((v) => v === 'sent').length,
    skipped: results.filter((v) => v === 'skipped').length,
    failed: results.filter((v) => v === 'failed').length,
  })
})
