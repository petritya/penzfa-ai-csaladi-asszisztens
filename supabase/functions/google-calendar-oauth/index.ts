import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

// A Google callback nyilvános GET végpont. A POST műveletek saját JWT-ellenőrzést végeznek.
// A felhasználói tokenek soha nem kerülnek a klienshez vagy a naplóba.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
}
const scope = 'https://www.googleapis.com/auth/calendar.events'
const callbackPath = '/functions/v1/google-calendar-oauth'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function html(message: string, status = 200): Response {
  const safe = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return new Response(
    '<!doctype html><html lang="hu"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Pénzfa – Google Naptár</title><body style="font-family:system-ui;max-width:34rem;margin:5rem auto;padding:1rem">' +
    '<h1>Pénzfa – Google Naptár</h1><p>' + safe + '</p><p>Térj vissza a Pénzfa alkalmazáshoz.</p></body></html>',
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } },
  )
}

function randomUrlSafe(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...data)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function sha256UrlSafe(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function secretKey(clientSecret: string): Promise<CryptoKey> {
  // MVP: a titkos Google OAuth klienskulcsból, alkalmazásspecifikus kontextusban
  // származtatunk AES kulcsot. Kulcscsere esetén új Google-engedélyezés szükséges.
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(clientSecret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256',
    salt: new TextEncoder().encode('penzfa-google-calendar-oauth-2026'),
    info: new TextEncoder().encode('refresh-token-encryption-v1'),
  }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function encryptRefreshToken(token: string, clientSecret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await secretKey(clientSecret)
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(token),
  ))
  return btoa(String.fromCharCode(...iv, ...encrypted))
}

async function decryptRefreshToken(value: string, clientSecret: string): Promise<string> {
  const all = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  const key = await secretKey(clientSecret)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12))
  return new TextDecoder().decode(plain)
}

// A Google Calendar eseményazonosítónak base32hex-karaktereket kell tartalmaznia.
 // A SHA-256 hexadecimális formája megfelel; a felhasználó+ügy páros determinisztikus.
async function deterministicCalendarId(userId: string, itemId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode('penzfa-calendar-v1:' + userId + ':' + itemId),
  ))
  return 'a' + Array.from(digest).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function nextCalendarDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

function safeOrigin(raw: string | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch { return null }
}

function redirectToApp(origin: string, status: 'connected' | 'error', ticket?: string, oauthState?: string): Response {
  const url = new URL(origin)
  if (ticket && oauthState && status === 'connected') {
    url.searchParams.set('google_calendar_ticket', ticket)
    url.searchParams.set('google_calendar_state', oauthState)
  } else {
    url.searchParams.set('google_calendar', 'error')
  }
  return new Response(null, {
    status: 303,
    headers: { Location: url.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  })
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const clientId = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID')
  const clientSecret = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET')
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'Hiányzó szerverkonfiguráció.' }, 500)

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const redirectUri = supabaseUrl.replace(/\/$/, '') + callbackPath

  try {
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams
      const state = params.get('state') ?? ''
      if (state.length < 32 || state.length > 200) return html('Hiányzó vagy érvénytelen engedélykérés.', 400)

      // Atomikus egyszer használatos state-felhasználás: előbb törlés, csak azután tokenváltás.
      const stateHash = await sha256UrlSafe(state)
      const { data: pending, error: consumeError } = await db.from('google_calendar_oauth_states')
        .delete().eq('state_hash', stateHash)
        .select('user_id, code_verifier, return_origin, expires_at').maybeSingle()
      if (consumeError || !pending || new Date(pending.expires_at).getTime() <= Date.now()) {
        return html('Az engedélykérés lejárt vagy már fel lett használva. Indítsd újra a Pénzfából.', 400)
      }

      const googleError = params.get('error')
      const code = params.get('code')
      if (googleError || !code) return redirectToApp(pending.return_origin, 'error')
      if (!clientId || !clientSecret) return html('A Google Naptár szerveroldali azonosítói hiányoznak.', 500)

      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: pending.code_verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
      })
      if (!tokenResponse.ok) return redirectToApp(pending.return_origin, 'error')
      const tokens = await tokenResponse.json() as { refresh_token?: string; scope?: string }
      if (!tokens.scope?.split(' ').includes(scope)) return redirectToApp(pending.return_origin, 'error')

      let refreshToken = tokens.refresh_token
      if (!refreshToken) {
        // A Google nem minden újraengedélyezéskor ad frissítési tokent.
        const { data: existing } = await db.from('google_calendar_connections')
          .select('refresh_token_encrypted').eq('user_id', pending.user_id).maybeSingle()
        if (existing?.refresh_token_encrypted) {
          refreshToken = await decryptRefreshToken(existing.refresh_token_encrypted, clientSecret)
        }
      }
      if (!refreshToken) return redirectToApp(pending.return_origin, 'error')

      const encrypted = await encryptRefreshToken(refreshToken, clientSecret)
      // A Google callback csak rövid életű, egyszer használható jegyet hoz létre.
      // A tényleges felhasználói kapcsolat csak az eredeti Pénzfa-munkamenetből jön létre.
      const ticket = randomUrlSafe()
      const ticketHash = await sha256UrlSafe(ticket)
      const { error: ticketError } = await db.from('google_calendar_oauth_completions').insert({
        ticket_hash: ticketHash,
        user_id: pending.user_id,
        refresh_token_encrypted: encrypted,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      if (ticketError) return redirectToApp(pending.return_origin, 'error')
      return redirectToApp(pending.return_origin, 'connected', ticket, state)
    }

    if (request.method !== 'POST') return json({ error: 'Nem támogatott kérés.' }, 405)
    const authorization = request.headers.get('Authorization')
    if (!authorization?.startsWith('Bearer ')) return json({ error: 'Bejelentkezés szükséges.' }, 401)

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: authData, error: authError } = await authClient.auth.getUser()
    if (authError || !authData.user) return json({ error: 'Érvénytelen felhasználói munkamenet.' }, 401)
    const userId = authData.user.id

    const body = await request.json().catch(() => ({})) as {
      action?: string
      confirmed?: boolean
      ticket?: string
      item_id?: string
      expected_updated_at?: string
    }
    if (body.action === 'status') {
      const { data, error } = await db.from('google_calendar_connections')
        .select('connected_at').eq('user_id', userId).maybeSingle()
      if (error) throw error
      return json({ connected: Boolean(data), connected_at: data?.connected_at ?? null })
    }

    if (body.action === 'prepare_calendar_export' || body.action === 'confirm_calendar_export') {
      // Nincs háttérszinkron: kizárólag egy konkrét, bejelentkezett felhasználó
      // által kijelölt, dátummal rendelkező, egész napos nyitott ügy exportálható.
      const itemId = typeof body.item_id === 'string' ? body.item_id : ''
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
        return json({ error: 'Érvénytelen ügyazonosító.' }, 400)
      }

      const { data: membership, error: membershipError } = await db.from('family_members')
        .select('family_id').eq('user_id', userId).eq('member_kind', 'active').maybeSingle()
      if (membershipError || !membership) return json({ error: 'Nincs aktív családi jogosultság.' }, 403)

      const { data: item, error: itemError } = await db.from('items')
        .select('id, family_id, title, notes, due_date, due_time, status, updated_at')
        .eq('id', itemId).eq('family_id', membership.family_id).maybeSingle()
      if (itemError || !item) return json({ error: 'Az ügy nem található a családodban.' }, 404)
      if (item.status !== 'open' || !item.due_date || item.due_time) {
        return json({ error: 'Ebben az első tesztben csak nyitott, dátumos, időpont nélküli ügy küldhető át egész napos eseményként.' }, 400)
      }

      // Elsődlegesen a Pénzfa tartós küldési naplója dönt.
      // A Google-ből való későbbi törlés SOHA nem oldja fel ezt a korlátot.
      const { data: exportLog, error: exportLogError } = await db.from('google_calendar_exports')
        .select('status').eq('user_id', userId).eq('item_id', item.id).maybeSingle()
      if (exportLogError) throw exportLogError
      if (exportLog?.status === 'sent') {
        return json({
          status: 'already_exists',
          message: 'Ezt az ügyet már korábban elküldtük a Google Naptárba. Nem küldjük újra, akkor sem, ha onnan törölted.',
        })
      }
      if (exportLog?.status === 'sending') {
        return json({
          status: 'delivery_uncertain',
          message: 'Ennél az ügynél már megkezdődött egy küldés, amelynek eredménye nem biztos. Az ismételt küldést megakadályoztuk.',
        })
      }

      const { data: connection, error: connectionError } = await db.from('google_calendar_connections')
        .select('refresh_token_encrypted').eq('user_id', userId).maybeSingle()
      if (connectionError || !connection) {
        return json({ error: 'Előbb kapcsolódj a Google Naptárhoz a Beállításokban.' }, 400)
      }

      if (body.action === 'prepare_calendar_export') {
        return json({
          status: 'needs_confirmation',
          draft: {
            item_id: item.id,
            title: item.title,
            date: item.due_date,
            notes: item.notes ?? null,
            expected_updated_at: item.updated_at,
          },
        })
      }

      if (body.confirmed !== true || body.expected_updated_at !== item.updated_at) {
        return json({ error: 'Az ügy időközben megváltozott, vagy hiányzik a jóváhagyás. Kérj új megerősítést.' }, 409)
      }
      if (!clientId || !clientSecret) return json({ error: 'A Google-kapcsolat szerverbeállítása hiányzik.' }, 503)

      const refreshToken = await decryptRefreshToken(connection.refresh_token_encrypted, clientSecret)
      const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      })
      if (!refreshResponse.ok) {
        return json({ error: 'A Google Naptár engedélye lejárt. Kapcsold újra a Google-fiókot a Beállításokban.' }, 401)
      }
      const refreshed = await refreshResponse.json() as { access_token?: string }
      if (!refreshed.access_token) return json({ error: 'A Google Naptár hozzáférése nem frissíthető.' }, 502)

      const eventId = await deterministicCalendarId(userId, item.id)
      // Atomi foglalás a hálózati küldés ELŐTT: párhuzamos kérésekből is csak egy indulhat.
      // Megszakadt/kétes válasznál a 'sending' sor megmarad, így nem küldjük újra vakon.
      const { error: reserveError } = await db.from('google_calendar_exports').insert({
        user_id: userId,
        item_id: item.id,
        event_id: eventId,
        status: 'sending',
      })
      if (reserveError) {
        if (reserveError.code === '23505') {
          // Két egyidejű kattintásból a másodikat a primer kulcs megállította.
          return json({ status: 'already_exists', message: 'Az ügy kiküldése már megtörtént vagy folyamatban van. Nem küldjük ki még egyszer.' })
        }
        throw reserveError
      }

      const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
      const eventBody = {
        id: eventId,
        summary: item.title,
        description: item.notes ?? '',
        start: { date: item.due_date },
        end: { date: nextCalendarDate(item.due_date) },
        visibility: 'private',
        reminders: { useDefault: false },
        extendedProperties: { private: { penzfa_item_id: item.id } },
      }

      const inserted = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + refreshed.access_token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventBody),
      })
      if (!inserted.ok && inserted.status !== 409) {
        // Biztosan elutasított klienshibáknál a küldés nem történt meg,
        // így a felhasználó később megpróbálhatja újra. Szerverhiba vagy
        // elveszett válasz esetén a foglalást NEM oldjuk fel.
        if ([400, 401, 403, 404, 429].includes(inserted.status)) {
          await db.from('google_calendar_exports')
            .delete().eq('user_id', userId).eq('item_id', item.id).eq('status', 'sending')
        }
        return json({ error: 'A Google Naptár nem fogadta el az eseményt. Ellenőrizd a naptárjogosultságot.' }, 502)
      }

      let created: { id?: string; htmlLink?: string } | null = null
      if (inserted.status !== 409) {
        created = await inserted.json() as { id?: string; htmlLink?: string }
        if (created.id !== eventId) {
          return json({ error: 'A Google Naptár válasza bizonytalan, ezért nem próbálkozunk automatikusan újra.' }, 502)
        }
      }
      const { error: markError } = await db.from('google_calendar_exports')
        .update({ status: 'sent', exported_at: new Date().toISOString() })
        .eq('user_id', userId).eq('item_id', item.id).eq('status', 'sending')
      if (markError) throw markError

      if (inserted.status === 409) {
        return json({ status: 'already_exists', message: 'Az esemény már szerepel a Google Naptárban, a kiküldést nyilvántartásba vettük.' })
      }
      return json({
        status: 'exported',
        message: 'Az esemény bekerült a Google Naptárba.',
        calendar_url: created?.htmlLink?.startsWith('https://calendar.google.com/') ? created.htmlLink : null,
      })
    }

    if (body.action === 'complete') {
      const ticket = String(body.ticket ?? '')
      if (ticket.length < 32 || ticket.length > 200) return json({ error: 'Érvénytelen összekapcsolási jegy.' }, 400)
      const ticketHash = await sha256UrlSafe(ticket)
      const { data: completion, error: consumeError } = await db.from('google_calendar_oauth_completions')
        .delete().eq('ticket_hash', ticketHash).eq('user_id', userId)
        .select('refresh_token_encrypted, expires_at').maybeSingle()
      if (consumeError || !completion || new Date(completion.expires_at).getTime() <= Date.now()) {
        return json({ error: 'Az összekapcsolás lejárt vagy már fel lett használva.' }, 400)
      }
      const { error: saveError } = await db.from('google_calendar_connections').upsert({
        user_id: userId,
        refresh_token_encrypted: completion.refresh_token_encrypted,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
      if (saveError) throw saveError
      return json({ connected: true })
    }

    if (body.action === 'start') {
      if (!clientId || !clientSecret) return json({ error: 'A Google OAuth kulcsok nincsenek beállítva a szerveren.' }, 503)
      const origin = safeOrigin(request.headers.get('Origin'))
      if (!origin) return json({ error: 'Az alkalmazás eredeti webcíme nem ellenőrizhető.' }, 400)
      const nonce = randomUrlSafe()
      const verifier = randomUrlSafe(48)
      const hash = await sha256UrlSafe(nonce)
      const challenge = await sha256UrlSafe(verifier)
      await db.from('google_calendar_oauth_states').delete().lt('expires_at', new Date().toISOString())
      await db.from('google_calendar_oauth_completions').delete().lt('expires_at', new Date().toISOString())
      const { error: stateError } = await db.from('google_calendar_oauth_states').insert({
        state_hash: hash,
        user_id: userId,
        code_verifier: verifier,
        return_origin: origin,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
      if (stateError) throw stateError
      const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      googleUrl.searchParams.set('client_id', clientId)
      googleUrl.searchParams.set('redirect_uri', redirectUri)
      googleUrl.searchParams.set('response_type', 'code')
      googleUrl.searchParams.set('scope', scope)
      googleUrl.searchParams.set('access_type', 'offline')
      googleUrl.searchParams.set('prompt', 'consent')
      googleUrl.searchParams.set('state', nonce)
      googleUrl.searchParams.set('code_challenge', challenge)
      googleUrl.searchParams.set('code_challenge_method', 'S256')
      return json({ authorization_url: googleUrl.toString(), state: nonce })
    }

    if (body.action === 'disconnect') {
      if (body.confirmed !== true) return json({ error: 'A kapcsolat bontását külön meg kell erősíteni.' }, 400)
      const { data: existing } = await db.from('google_calendar_connections')
        .select('refresh_token_encrypted').eq('user_id', userId).maybeSingle()
      if (existing?.refresh_token_encrypted && clientSecret) {
        try {
          const token = await decryptRefreshToken(existing.refresh_token_encrypted, clientSecret)
          await fetch('https://oauth2.googleapis.com/revoke', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }),
          })
        } catch { /* Ha a token lejárt, a helyi kapcsolatot akkor is bontjuk. */ }
      }
      const { error } = await db.from('google_calendar_connections').delete().eq('user_id', userId)
      if (error) throw error
      return json({ connected: false })
    }

    return json({ error: 'Ismeretlen művelet.' }, 400)
  } catch {
    // Nem írunk naplóba tokent vagy OAuth-kódot.
    return json({ error: 'A Google Naptár kapcsolat feldolgozása nem sikerült.' }, 500)
  }
})
