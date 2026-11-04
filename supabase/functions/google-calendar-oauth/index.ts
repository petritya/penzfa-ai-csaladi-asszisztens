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


function calendarEventWindow(date: string, time: string | null, timeZone: string) {
  if (!time) return {
    start: { date },
    end: { date: nextCalendarDate(date) },
  }

  // A Pénzfában a dátum és idő helyi érték. Az IANA időzóna alapján
  // valós időpontra alakítjuk, majd PONTOSAN 60 percet adunk hozzá.
  // Így az óraátállításon átívelő program is valóban egyórás.
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
  const representedParts = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  )
  const representedTime = Date.UTC(
    Number(representedParts.year), Number(representedParts.month) - 1, Number(representedParts.day),
    Number(representedParts.hour), Number(representedParts.minute),
  )
  if (representedTime !== desired) throw new Error('Nonexistent time during timezone change')

  return {
    start: { dateTime: new Date(instant).toISOString(), timeZone },
    end: { dateTime: new Date(instant + 60 * 60_000).toISOString(), timeZone },
  }
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
      item_ids?: string[]
      expected_updated_at?: string
      allow_resend?: boolean
      enabled?: boolean
      event_id?: string
      change_id?: string
      decision?: 'accept' | 'reject'
    }
    if (body.action === 'status') {
      const { data, error } = await db.from('google_calendar_connections')
        .select('connected_at, auto_export_enabled_at, auto_export_error, auto_import_enabled_at, auto_import_error').eq('user_id', userId).maybeSingle()
      if (error) throw error
      return json({
        connected: Boolean(data),
        connected_at: data?.connected_at ?? null,
        auto_export_enabled: Boolean(data?.auto_export_enabled_at),
        auto_export_error: data?.auto_export_error ?? null,
        auto_import_enabled: Boolean(data?.auto_import_enabled_at),
        auto_import_error: data?.auto_import_error ?? null,
      })
    }


    // Google -> asszisztens: az egy már összekapcsolt eseményre vonatkozó
    // módosítás/törlés nem mehet át felhasználói döntés nélkül.
    if (body.action === 'get_linked_calendar_item') {
      const id = String(body.item_id ?? '')
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return json({linked:false})
      }
      const { data: link } = await db.from('google_calendar_exports')
        .select('event_id,status,google_deleted_at').eq('user_id',userId)
        .eq('item_id',id).maybeSingle()
      return json({linked:Boolean(link?.status==='sent'&&!link.google_deleted_at)})
    }

    // Két külön explicit döntés: lokális törlés után a Google Naptárból
    // kizárólag a második, külön megerősített kérés törölhet.
    if (body.action === 'delete_linked_calendar_event') {
      const id = String(body.item_id ?? '')
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        || body.confirmed!==true) {
        return json({error:'A Google-esemény törléséhez külön megerősítés kell.'},400)
      }
      const {data:member}=await db.from('family_members')
        .select('family_id').eq('user_id',userId).eq('member_kind','active').maybeSingle()
      if (!member) return json({error:'Nincs családi jogosultság.'},403)
      const [{data:item},{data:link},{data:connection}]=await Promise.all([
        db.from('items').select('id,status').eq('id',id).eq('family_id',member.family_id)
          .eq('responsible_user_id',userId).maybeSingle(),
        db.from('google_calendar_exports')
          .select('event_id,status,sync_google_etag,exported_at,google_deleted_at')
          .eq('user_id',userId).eq('item_id',id).maybeSingle(),
        db.from('google_calendar_connections')
          .select('refresh_token_encrypted').eq('user_id',userId).maybeSingle(),
      ])
      if (!item || item.status!=='deleted' || !link || link.status!=='sent')
        return json({error:'Előbb a megfelelő saját ügyet töröld az asszisztensből.'},409)
      if (link.google_deleted_at) return json({status:'deleted'})
      if (!connection || !clientId || !clientSecret)
        return json({error:'Kapcsold össze újra a Google Naptárat.'},409)
      try {
        const refreshToken=await decryptRefreshToken(connection.refresh_token_encrypted,clientSecret)
        const refresh=await fetch('https://oauth2.googleapis.com/token',{
          method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
          body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,
            refresh_token:refreshToken,grant_type:'refresh_token'}),
          signal:AbortSignal.timeout(8000),
        })
        if (!refresh.ok) return json({error:'A Google-engedély frissítése nem sikerült.'},502)
        const accessToken=(await refresh.json() as {access_token?:string}).access_token
        if (!accessToken) return json({error:'Hiányzó Google-hozzáférés.'},502)
        const endpoint='https://www.googleapis.com/calendar/v3/calendars/primary/events/'
          +encodeURIComponent(link.event_id)
        const remoteRes=await fetch(endpoint,{
          headers:{Authorization:'Bearer '+accessToken},signal:AbortSignal.timeout(10000)})
        if (remoteRes.status===404||remoteRes.status===410) {
          await db.from('google_calendar_exports')
            .update({google_deleted_at:new Date().toISOString(),sync_error:null})
            .eq('user_id',userId).eq('item_id',id)
          return json({status:'deleted'})
        }
        if (!remoteRes.ok) return json({error:'A Google-esemény ellenőrzése nem sikerült.'},502)
        const remote=await remoteRes.json() as {id?:string;etag?:string;updated?:string;status?:string}
        if (remote.id!==link.event_id||!remote.etag)return json({error:'Az esemény nem ellenőrizhető.'},409)
        const changed=link.sync_google_etag
          ?remote.etag!==link.sync_google_etag
          :Boolean(remote.updated&&Date.parse(remote.updated)>Date.parse(link.exported_at)+30000)
        if (changed) return json({error:'A Google-esemény közben megváltozott. A törlést nem hajtottuk végre.'},409)
        const deleted=await fetch(endpoint+'?sendUpdates=none',{
          method:'DELETE',headers:{Authorization:'Bearer '+accessToken,'If-Match':remote.etag},
          signal:AbortSignal.timeout(10000),
        })
        if (deleted.status===412)return json({error:'A Google-esemény törlés közben módosult.'},409)
        if (!deleted.ok&&deleted.status!==404&&deleted.status!==410)
          return json({error:'A Google Naptár nem fogadta el a törlést.'},502)
        await db.from('google_calendar_exports')
          .update({google_deleted_at:new Date().toISOString(),sync_error:null})
          .eq('user_id',userId).eq('item_id',id)
        await db.from('activity_log').insert({
          family_id:member.family_id,actor_user_id:userId,item_id:id,
          action:'calendar_event_deleted_by_request',
          details:{event_id:link.event_id},
        })
        return json({status:'deleted'})
      } catch {
        // Bizonytalan kimenetnél nem ismétlünk törlést automatikusan.
        return json({error:'A Google Naptár törlésének eredménye nem biztos. Ellenőrizd a naptárban.'},502)
      }
    }

    if (body.action === 'list_calendar_changes') {
      const { data, error } = await db.from('google_calendar_change_candidates')
        .select('id,event_id,item_id,change_type,title,notes,due_date,due_time,discovered_at')
        .eq('user_id', userId).eq('status','pending')
        .order('discovered_at',{ascending:false}).limit(30)
      if (error) throw error
      // Több új Google-verzióból csak a legutóbbit ajánljuk fel ugyanahhoz az eseményhez.
      const seen = new Set<string>()
      const changes = (data ?? []).filter(row => {
        if (seen.has(row.event_id)) return false
        seen.add(row.event_id)
        return true
      })
      return json({ items: changes })
    }

    if (body.action === 'decide_calendar_change') {
      const id = String(body.change_id ?? '')
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        || (body.decision !== 'accept' && body.decision !== 'reject')
        || body.confirmed !== true) {
        return json({ error: 'A döntéshez eseményazonosító és megerősítés szükséges.' }, 400)
      }
      const { data: member } = await db.from('family_members')
        .select('family_id').eq('user_id',userId)
        .eq('member_kind','active').maybeSingle()
      if (!member) return json({ error: 'Nincs családi jogosultság.' }, 403)
      const { data: candidate, error: candidateError } = await db.from('google_calendar_change_candidates')
        .select('*').eq('id',id).eq('user_id',userId).eq('status','pending').maybeSingle()
      if (candidateError) throw candidateError
      if (!candidate) return json({ error: 'A változtatási javaslat már nem aktív.' }, 409)
      const { data: item } = await db.from('items').select('id,title,status,updated_at')
        .eq('id',candidate.item_id).eq('family_id',member.family_id)
        .eq('responsible_user_id',userId).maybeSingle()
      if (!item || item.status !== 'open') return json({ error: 'A kapcsolódó ügy már nem nyitott.' }, 409)
      if (item.updated_at !== candidate.item_updated_at) {
        await db.from('google_calendar_change_candidates')
          .update({status:'conflict',decided_at:new Date().toISOString()})
          .eq('id',id).eq('user_id',userId).eq('status','pending')
        return json({ error: 'Az ügy időközben megváltozott az asszisztensben. Nem írtunk felül adatot.' }, 409)
      }

      if (body.decision === 'reject') {
        const { data: declined, error: declinedError } = await db.from('google_calendar_change_candidates')
          .update({status:'declined',decided_at:new Date().toISOString()})
          .eq('id',id).eq('user_id',userId).eq('status','pending')
          .select('id').maybeSingle()
        if (declinedError) throw declinedError
        if (!declined) return json({ error:'A döntést időközben már kezelték.' },409)
        // Kifejezett Google-oldali eltérés marad: későbbi helyi mentés se
        // írja felül automatikusan a felhasználó által elutasított verziót.
        await db.from('google_calendar_exports')
          .update({sync_status:'conflict',sync_error:'google_change_declined'})
          .eq('item_id',candidate.item_id).eq('event_id',candidate.event_id)
          .eq('user_id',userId)
        return json({ status:'declined' })
      }

      // Védett egyszeri feldolgozás: ugyanarra a javaslatra nem lehet
      // két párhuzamos jóváhagyást végrehajtani.
      const { data: claimed, error: claimError } = await db.from('google_calendar_change_candidates')
        .update({status:'processing'}).eq('id',id).eq('user_id',userId)
        .eq('status','pending').select('id').maybeSingle()
      if (claimError) throw claimError
      if (!claimed) return json({ error:'A döntés már feldolgozás alatt van.' },409)
      async function resetCandidate(status:'pending'|'conflict') {
        await db.from('google_calendar_change_candidates')
          .update({status,decided_at:status==='conflict'?new Date().toISOString():null})
          .eq('id',id).eq('user_id',userId).eq('status','processing')
      }

      // Az érvényes Google-verziót közvetlenül a jóváhagyás előtt újra
      // ellenőrizzük, hogy időközben történt módosítást ne fogadjunk el vakon.
      const { data: connection } = await db.from('google_calendar_connections')
        .select('refresh_token_encrypted').eq('user_id',userId).maybeSingle()
      if (!connection || !clientId || !clientSecret) {
        await resetCandidate('pending')
        return json({error:'Kapcsold össze újra a Google Naptárat.'},409)
      }
      try {
        const refreshToken = await decryptRefreshToken(connection.refresh_token_encrypted,clientSecret)
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token',{
          method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
          body:new URLSearchParams({
            client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,
            grant_type:'refresh_token',
          }),signal:AbortSignal.timeout(8000),
        })
        if (!tokenResponse.ok) {
          await resetCandidate('pending')
          return json({error:'A Google-engedély frissítése nem sikerült.'},502)
        }
        const token=(await tokenResponse.json() as {access_token?:string}).access_token
        if (!token) {await resetCandidate('pending');return json({error:'Hiányzó Google-engedély.'},502)}
        const evResponse=await fetch(
          'https://www.googleapis.com/calendar/v3/calendars/primary/events/'+encodeURIComponent(candidate.event_id),
          {headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)})
        if (candidate.change_type==='update') {
          if (!evResponse.ok) {
            await resetCandidate('conflict')
            return json({error:'A Google-esemény már nem érhető el változatlanul.'},409)
          }
          const ev=await evResponse.json() as {etag?:string;status?:string}
          if (ev.etag!==candidate.google_etag||ev.status==='cancelled') {
            await resetCandidate('conflict')
            return json({error:'A Google-esemény újra megváltozott; az átvételt nem hajtottuk végre.'},409)
          }
        } else if (evResponse.ok) {
          const ev=await evResponse.json() as {status?:string}
          if (ev.status!=='cancelled') {
            await resetCandidate('conflict')
            return json({error:'A Google-esemény már nem törölt; a törlést nem hajtottuk végre.'},409)
          }
        } else if (evResponse.status!==404 && evResponse.status!==410) {
          await resetCandidate('pending')
          return json({error:'A Google-esemény törlése nem ellenőrizhető.'},502)
        }
      } catch {
        await resetCandidate('pending')
        return json({error:'A Google ellenőrzése hálózati hiba miatt nem sikerült.'},502)
      }

      if (candidate.change_type==='update' && (!candidate.title || !candidate.due_date)) {
        await resetCandidate('conflict')
        return json({error:'A változás adatai hiányosak.'},409)
      }
      const values: Record<string,unknown> = candidate.change_type==='delete'
        ? {status:'deleted',completed_at:null}
        : {title:candidate.title,notes:candidate.notes,due_date:candidate.due_date,
          due_time:candidate.due_time}
      const { data: updated, error: updateError } = await db.from('items')
        .update(values).eq('id',candidate.item_id).eq('family_id',member.family_id)
        .eq('responsible_user_id',userId).eq('status','open')
        .eq('updated_at',candidate.item_updated_at)
        .select('id,updated_at').maybeSingle()
      if (updateError || !updated) {
        await resetCandidate('conflict')
        return json({error:'Az ügy időközben megváltozott, ezért nem írtunk felül semmit.'},409)
      }
      if (candidate.change_type==='delete') {
        await db.from('reminders').update({enabled:false,next_notification_at:null})
          .eq('item_id',updated.id)
      }
      await db.from('google_calendar_exports').update({
        sync_local_updated_at:updated.updated_at,
        sync_google_etag:candidate.google_etag,
        sync_status:'synced',sync_error:null,
      }).eq('user_id',userId).eq('item_id',updated.id)
        .eq('event_id',candidate.event_id).eq('status','sent')
      await db.from('google_calendar_change_candidates')
        .update({status:'accepted',decided_at:new Date().toISOString()})
        .eq('id',id).eq('user_id',userId).eq('status','processing')
      await db.from('activity_log').insert({
        family_id:member.family_id,actor_user_id:userId,item_id:updated.id,
        action:candidate.change_type==='delete'?'calendar_delete_accepted':'calendar_change_accepted',
        details:{google_event_id:candidate.event_id,change_type:candidate.change_type},
      })
      return json({status:'accepted',change_type:candidate.change_type})
    }

    if (body.action === 'set_auto_import') {
      if (typeof body.enabled !== 'boolean') return json({ error: 'Hiányzik a naptárfigyelés beállítása.' }, 400)
      if (body.enabled && body.confirmed !== true) return json({ error: 'A Google Naptár figyelését külön jóvá kell hagynod.' }, 400)
      // Minden új engedélyezés friss kezdőpont; visszamenőleg nincs importjavaslat.
      const { data: updated, error: updateError } = await db.from('google_calendar_connections')
        .update({
          auto_import_enabled_at: body.enabled ? new Date().toISOString() : null,
          auto_import_last_scanned_at: null,
          auto_import_error: null,
        })
        .eq('user_id', userId)
        .select('auto_import_enabled_at').maybeSingle()
      if (updateError) throw updateError
      if (!updated) return json({ error: 'A Google Naptár nincs csatlakoztatva.' }, 400)
      return json({ auto_import_enabled: Boolean(updated.auto_import_enabled_at) })
    }

    // Csak az aktuális felhasználó saját korábbi naptárküldéseit adjuk vissza.
    // A 'sending' állapotot is foglaltnak tekintjük: így nem ajánlunk fel
    // ismételt küldést bizonytalan korábbi eredménynél.
    if (body.action === 'list_calendar_export_statuses') {
      const itemIds = body.item_ids
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (!Array.isArray(itemIds) || itemIds.length > 100
        || itemIds.some((id) => typeof id !== 'string' || !uuid.test(id))) {
        return json({ error: 'Érvénytelen ügyazonosító-lista.' }, 400)
      }
      if (itemIds.length === 0) return json({ exported_item_ids: [] })
      const { data, error } = await db.from('google_calendar_exports')
        .select('item_id').eq('user_id', userId).in('item_id', itemIds)
      if (error) throw error
      return json({ exported_item_ids: (data ?? []).map((entry) => entry.item_id) })
    }

    if (body.action === 'list_calendar_imports') {
      const now = new Date().toISOString()
      // Csak bejelentkezett felhasználó saját, még eldönthető javaslatait adjuk át.
      const { data, error } = await db.from('google_calendar_import_candidates')
        .select('event_id, title, notes, due_date, due_time, expires_at')
        .eq('user_id', userId).eq('status', 'pending')
        .gt('expires_at', now).order('discovered_at', { ascending: false }).limit(20)
      if (error) throw error
      return json({ items: data ?? [] })
    }

    if (body.action === 'decide_calendar_import') {
      const eventId = typeof body.event_id === 'string' ? body.event_id : ''
      if (!eventId || eventId.length > 1024 ||
          (body.decision !== 'accept' && body.decision !== 'reject') ||
          body.confirmed !== true) {
        return json({ error: 'Az átvételhez konkrét eseményt és megerősítést kell megadni.' }, 400)
      }
      const { data: member, error: memberError } = await db.from('family_members')
        .select('family_id').eq('user_id', userId).eq('member_kind', 'active').maybeSingle()
      if (memberError || !member) return json({ error: 'Nincs aktív családi jogosultság.' }, 403)
      const now = new Date().toISOString()
      // Atomikus állapotváltás. Párhuzamos kattintásból nem lesz két ügy.
      const nextStatus = body.decision === 'accept' ? 'accepting' : 'declined'
      const { data: claimed, error: claimError } = await db.from('google_calendar_import_candidates')
        .update({
          status: nextStatus,
          ...(nextStatus === 'declined' ? { decided_at: now, notes: null } : {}),
        })
        .eq('user_id', userId).eq('event_id', eventId).eq('status', 'pending')
        .gt('expires_at', now)
        .select('event_id, title, notes, due_date, due_time').maybeSingle()
      if (claimError) throw claimError
      if (!claimed) return json({ error: 'Az eseményt már elbíráltuk vagy a javaslat lejárt.' }, 409)
      if (body.decision === 'reject') return json({ status: 'declined' })

      // Determinisztikus UUID: hiba vagy újrapróbálkozás sem hozhat létre második ügyet.
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode('penzfa-google-inbound-v1:' + userId + ':' + eventId)))
      digest[6] = (digest[6] & 15) | 64
      digest[8] = (digest[8] & 63) | 128
      const hex = Array.from(digest.slice(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join('')
      const itemId = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16)
        + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32)

      // A védőnaplót még az ügy létrehozása ELŐTT rögzítjük:
      // így az automatikus Pénzfa -> Google kör egy párhuzamos futás alatt
      // sem tudja visszaküldeni a Google-ből importált eseményt.
      const { error: exportError } = await db.from('google_calendar_exports').insert({
        user_id: userId, item_id: itemId, event_id: eventId,
        status: 'sent', exported_at: now,
      })
      if (exportError && exportError.code !== '23505') {
        await db.from('google_calendar_import_candidates').update({ status: 'pending' })
          .eq('user_id', userId).eq('event_id', eventId).eq('status', 'accepting')
        return json({ error: 'A duplikációvédelem rögzítése nem sikerült.' }, 500)
      }

      const { error: itemError } = await db.from('items').insert({
        id: itemId,
        family_id: member.family_id,
        created_by: userId,
        responsible_user_id: userId,
        item_type: 'event',
        title: claimed.title,
        notes: claimed.notes,
        due_date: claimed.due_date,
        due_time: claimed.due_time,
        status: 'open',
      })
      if (itemError && itemError.code !== '23505') {
        // Sikertelen INSERT után oldjuk fel az újonnan létrehozott védelmet,
        // az ügy újra jóváhagyható lesz. Ismeretlen kimenetnél marad a zárolás.
        const {data: actualItem} = await db.from('items').select('id').eq('id', itemId).maybeSingle()
        if (!actualItem) {
          if (!exportError) await db.from('google_calendar_exports').delete()
            .eq('user_id', userId).eq('item_id', itemId).eq('event_id', eventId)
          await db.from('google_calendar_import_candidates').update({status: 'pending'})
            .eq('user_id', userId).eq('event_id', eventId).eq('status', 'accepting')
        }
        return json({error: 'A Pénzfa-ügy létrehozása nem sikerült.'},500)
      }
      const { error: finishError } = await db.from('google_calendar_import_candidates')
        .update({ status: 'accepted', item_id: itemId, decided_at: now })
        .eq('user_id', userId).eq('event_id', eventId).eq('status', 'accepting')
      if (finishError) throw finishError
      return json({ status: 'accepted', item_id: itemId })
    }

    if (body.action === 'set_auto_export') {
      if (typeof body.enabled !== 'boolean') return json({ error: 'Hiányzó automatikus küldési beállítás.' }, 400)
      if (body.enabled && body.confirmed !== true) return json({ error: 'Az automatikus küldés bekapcsolásához megerősítés szükséges.' }, 400)

      // Visszakapcsoláskor új kezdőpontot veszünk fel; nincs korábbi feladatok utólagos kiküldése.
      const { data: result, error: updateError } = await db.from('google_calendar_connections')
        .update({
          auto_export_enabled_at: body.enabled ? new Date().toISOString() : null,
          auto_export_error: null,
        })
        .eq('user_id', userId)
        .select('auto_export_enabled_at').maybeSingle()
      if (updateError) throw updateError
      if (!result) return json({ error: 'Nincs összekapcsolt Google Naptár.' }, 400)
      return json({ auto_export_enabled: Boolean(result.auto_export_enabled_at) })
    }

    if (body.action === 'prepare_calendar_export' || body.action === 'confirm_calendar_export') {
      // Kizárólag egy konkrét, bejelentkezett felhasználó
      // által kijelölt, dátumos nyitott ügy exportálható.
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
      if (item.status !== 'open' || !item.due_date) {
        return json({ error: 'Csak nyitott, dátummal rendelkező ügy küldhető át a Google Naptárba.' }, 400)
      }

      // Elsődlegesen a Pénzfa tartós küldési naplója dönt.
      // A Google-ből való későbbi törlés SOHA nem oldja fel ezt a korlátot.
      const { data: exportLog, error: exportLogError } = await db.from('google_calendar_exports')
        .select('status, event_id, resend_count').eq('user_id', userId).eq('item_id', item.id).maybeSingle()
      if (exportLogError) throw exportLogError
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
            time: item.due_time,
            notes: item.notes ?? null,
            expected_updated_at: item.updated_at,
            resend: exportLog?.status === 'sent',
          },
        })
      }

      // Újraküldést kizárólag a kifejezetten jóváhagyott kézi kérés engedhet.
      // Az automatikus folyamat ezt a kapcsolót soha nem állíthatja be.
      if (exportLog?.status === 'sent' && body.allow_resend !== true) {
        return json({ status: 'already_exists', message: 'Korábban már kiküldtük az eseményt. Újraküldéshez külön jóváhagyás szükséges.' })
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

      const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
      const isManualResend = exportLog?.status === 'sent'

      if (isManualResend) {
        // A régi Google-eseményt ellenőrizzük, NEM a naptár egészét.
        // Sikeres GET esetén a cancelled státusz törlést jelenthet.
        // Más Google API hiba (401, 403, 500 stb.) soha nem enged újraküldést.
        const existingResponse = await fetch(url + '/' + encodeURIComponent(exportLog.event_id), {
          headers: { Authorization: 'Bearer ' + refreshed.access_token },
        })
        if (existingResponse.ok) {
          const existing = await existingResponse.json() as { status?: string }
          if (existing.status !== 'cancelled') {
            return json({ status: 'still_exists', message: 'Ellenőriztem: az esemény továbbra is szerepel a Google Naptárban. Nem készült másolat.' })
          }
        } else if (existingResponse.status !== 404) {
          return json({ error: 'A Google Naptárban nem sikerült megbízhatóan ellenőrizni az eseményt. Nem küldjük újra.' }, 502)
        }
      }

      // Törölt eseményhez ÚJ, körönként egyedi azonosítót használunk,
      // mert a Google a törölt azonosítót tombstone-ként is megtarthatja.
      const nextResendCount = (exportLog?.resend_count ?? 0) + (isManualResend ? 1 : 0)
      const eventId = await deterministicCalendarId(
        userId,
        isManualResend ? item.id + ':resend:' + nextResendCount : item.id,
      )

      if (isManualResend) {
        // Atomi állapotátmenet: két párhuzamos manuális jóváhagyásból
        // egyedül az első foglalhatja le az ügyet.
        const { data: locked, error: lockError } = await db.from('google_calendar_exports')
          .update({ status: 'sending' })
          .eq('user_id', userId)
          .eq('item_id', item.id)
          .eq('event_id', exportLog.event_id)
          .eq('resend_count', exportLog.resend_count)
          .eq('status', 'sent')
          .select('item_id').maybeSingle()
        if (lockError) throw lockError
        if (!locked) {
          return json({ status: 'delivery_uncertain', message: 'Egy másik kérés már megkezdte a küldést. Nem készül második példány.' })
        }
      } else {
        // Új ügy: atomi foglalás a Google API hívás ELŐTT.
        const { error: reserveError } = await db.from('google_calendar_exports').insert({
          user_id: userId,
          item_id: item.id,
          event_id: eventId,
          status: 'sending',
        })
        if (reserveError) {
          if (reserveError.code === '23505') {
            return json({ status: 'delivery_uncertain', message: 'Az ügy kiküldése már megtörtént vagy folyamatban van.' })
          }
          throw reserveError
        }
      }
      const { data: userSettings, error: settingsError } = await db.from('user_settings')
        .select('timezone').eq('user_id', userId).maybeSingle()
      if (settingsError) throw settingsError
      const timeZone = userSettings?.timezone || 'Europe/Budapest'
      // Érvénytelen időzóna vagy helyi idő esetén még NINCS Google API hívás.
      // Az előzetes foglalást feloldjuk; a felhasználó kijavíthatja a beállítását.
      let window: ReturnType<typeof calendarEventWindow>
      try {
        window = calendarEventWindow(item.due_date, item.due_time, timeZone)
      } catch {
        if (isManualResend) {
          await db.from('google_calendar_exports').update({ status: 'sent' })
            .eq('user_id', userId).eq('item_id', item.id)
            .eq('event_id', exportLog.event_id).eq('status', 'sending')
        } else {
          await db.from('google_calendar_exports').delete()
            .eq('user_id', userId).eq('item_id', item.id).eq('status', 'sending')
        }
        return json({ error: 'Az esemény helyi időpontja vagy időzónája nem érvényes.' }, 400)
      }
      const eventBody = {
        id: eventId,
        summary: item.title,
        description: item.notes ?? '',
        ...window,
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
          if (isManualResend) {
            // A korábbi sikeres kiküldés nyoma a sikertelen újraküldéstől is megmarad.
            await db.from('google_calendar_exports')
              .update({ status: 'sent' })
              .eq('user_id', userId).eq('item_id', item.id)
              .eq('event_id', exportLog.event_id).eq('status', 'sending')
          } else {
            await db.from('google_calendar_exports')
              .delete().eq('user_id', userId).eq('item_id', item.id).eq('status', 'sending')
          }
        }
        return json({ error: 'A Google Naptár nem fogadta el az eseményt. Ellenőrizd a naptárjogosultságot.' }, 502)
      }

      let created: { id?: string; htmlLink?: string; etag?: string } | null = null
      if (inserted.status !== 409) {
        created = await inserted.json() as { id?: string; htmlLink?: string; etag?: string }
        if (created.id !== eventId) {
          return json({ error: 'A Google Naptár válasza bizonytalan, ezért nem próbálkozunk automatikusan újra.' }, 502)
        }
      }
      const { error: markError } = await db.from('google_calendar_exports')
        .update({
          status: 'sent',
          event_id: eventId,
          resend_count: nextResendCount,
          exported_at: new Date().toISOString(),
          sync_local_updated_at: item.updated_at,
          sync_google_etag: created?.etag ?? null,
          sync_status: 'synced',
          sync_error: null,
        })
        .eq('user_id', userId).eq('item_id', item.id).eq('status', 'sending')
        .eq('event_id', isManualResend ? exportLog.event_id : eventId)
      if (markError) throw markError

      if (inserted.status === 409) {
        return json({ status: 'already_exists', message: 'Az esemény már szerepel a Google Naptárban, a kiküldést nyilvántartásba vettük.' })
      }
      return json({
        status: 'exported',
        message: isManualResend ? 'Az esemény kérésedre ismét bekerült a Google Naptárba.' : 'Az esemény bekerült a Google Naptárba.',
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
        auto_export_error: null,
        auto_import_enabled_at: null,
        auto_import_last_scanned_at: null,
        auto_import_error: null,
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
