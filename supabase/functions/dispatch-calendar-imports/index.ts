import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

// Google Naptár -> Pénzfa: csak opt-in után létrehozott, önálló események.
// Egyszeri push, tartós döntési napló, soha nincs automatikus ügy létrehozás.
const url = Deno.env.get('SUPABASE_URL') ?? ''
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const googleClientId = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID') ?? ''
const googleClientSecret = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET') ?? ''

function json(payload: unknown, status=200) {
  return new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' },
  })
}
type Event = {
  id?: string; status?: string; eventType?: string; summary?: string; etag?: string; updated?: string;
  description?: string; created?: string; recurrence?: string[];
  recurringEventId?: string; extendedProperties?: { private?: { penzfa_item_id?: string } };
  start?: { date?: string; dateTime?: string };
}
type Connection = {
  user_id: string; refresh_token_encrypted: string;
  auto_import_enabled_at: string; auto_import_last_scanned_at: string | null;
}
function localParts(timeZone: string, date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit', minute:'2-digit',hourCycle:'h23',
  }).formatToParts(date)
  const v = Object.fromEntries(parts.map(x=>[x.type,x.value]))
  return { date: v.year+'-'+v.month+'-'+v.day, time:v.hour+':'+v.minute }
}
function addDays(date: string, n: number) {
  const [y,m,d] = date.split('-').map(Number)
  return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10)
}
function localMidnightUtc(date: string, timeZone: string) {
  const [y,m,d] = date.split('-').map(Number)
  const desired = Date.UTC(y,m-1,d)
  let instant=desired
  const fmt=new Intl.DateTimeFormat('en-CA',{
    timeZone, year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23',
  })
  for(let i=0;i<4;i++){
    const v=Object.fromEntries(fmt.formatToParts(new Date(instant)).map(x=>[x.type,x.value]))
    const found=Date.UTC(Number(v.year),Number(v.month)-1,Number(v.day),Number(v.hour),Number(v.minute))
    if(found===desired)break
    instant+=desired-found
  }
  return new Date(instant).toISOString()
}
async function decryptRefreshToken(value:string) {
  const encrypted=Uint8Array.from(atob(value),s=>s.charCodeAt(0))
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(googleClientSecret),'HKDF',false,['deriveKey'])
  const k=await crypto.subtle.deriveKey({
    name:'HKDF',hash:'SHA-256',
    salt:new TextEncoder().encode('penzfa-google-calendar-oauth-2026'),
    info:new TextEncoder().encode('refresh-token-encryption-v1'),
  },base,{name:'AES-GCM',length:256},false,['decrypt'])
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:encrypted.slice(0,12)},k,encrypted.slice(12)))
}
async function notifyOnce(userId:string,title:string,locale:string,changeType?: 'update'|'delete') {
  const appId=Deno.env.get('ONESIGNAL_APP_ID')
  const token=Deno.env.get('ONESIGNAL_REST_API_KEY')
  if(!appId||!token)return false
  const root=(Deno.env.get('APP_URL')??'https://csalad.andraspetrity.eu').replace(/\/$/,'')
  const da=locale==='da-DK'
  try {
    const r=await fetch('https://api.onesignal.com/notifications',{
      method:'POST',
      headers:{Authorization:'Key '+token,'Content-Type':'application/json'},
      body:JSON.stringify({
        app_id:appId,include_aliases:{external_id:[userId]},target_channel:'push',
        headings:{en:changeType === 'delete'
          ? (da ? 'Slettet i Google Kalender' : 'Törlés a Google Naptárban')
          : changeType === 'update'
            ? (da ? 'Ændring i Google Kalender' : 'Módosítás a Google Naptárban')
            : (da?'Ny begivenhed i Google Kalender':'Új esemény a Google Naptárban')},
        contents:{en:changeType === 'delete'
          ? (da ? 'Vil du også slette i assistenten: ' : 'Az asszisztensből is törlöd: ') + title + '?'
          : changeType === 'update'
            ? (da ? 'Vil du overføre ændringen: ' : 'Átveszed a módosítást: ') + title + '?'
            : (da ? 'Vil du overføre: ' : 'Átveszed az asszisztensbe: ') + title + '?')},
        url:root+'/?push=calendar-import',
      }),
      signal:AbortSignal.timeout(8000),
    })
    const body=await r.json().catch(()=>({}))
    return r.ok&&Boolean(body?.id)
  }catch{return false}
}

Deno.serve(async(req:Request)=>{
  if(req.method!=='POST')return json({error:'Csak POST.'},405)
  if(!url||!key||!googleClientId||!googleClientSecret)return json({error:'Szerverbeállítás hiányzik.'},503)
  // A Supabase Gateway a meglevő Cron JWT-t ellenőrzi (verify_jwt=true).
  if(!req.headers.get('Authorization')?.startsWith('Bearer '))return json({error:'Hitelesítés szükséges.'},401)
  const body=await req.json().catch(()=>({})) as {source?:string}
  if(body.source!=='cron')return json({error:'Nem időzített kérés.'},400)
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date()
  const {data:claim,error:claimError}=await db.from('google_calendar_import_runs')
    .update({last_run_at:now.toISOString()})
    .eq('id',1).lte('last_run_at',new Date(now.getTime()-4*60_000).toISOString())
    .select('id').maybeSingle()
  if(claimError)return json({error:'Ütemezés nem elérhető.'},500)
  if(!claim)return json({status:'skipped',reason:'recent_run'})

  // Nem válaszolt javaslatok: másnap éjfélkor lezárulnak, örökre ismert ID-vel.
  await db.from('google_calendar_import_candidates')
    .update({status:'expired',notes:null,decided_at:now.toISOString()})
    .eq('status','pending').lte('expires_at',now.toISOString())

  const {data:connections,error:readError}=await db.from('google_calendar_connections')
    .select('user_id,refresh_token_encrypted,auto_import_enabled_at,auto_import_last_scanned_at')
    .not('auto_import_enabled_at','is',null).is('auto_import_error',null).limit(10)
  if(readError)return json({error:'Kapcsolatok lekérdezése sikertelen.'},500)
  const output:unknown[]=[]
  for(const c of (connections??[]) as Connection[]) {
    try {
      const {data:settings}=await db.from('user_settings')
        .select('timezone,ui_locale').eq('user_id',c.user_id).maybeSingle()
      const timeZone=settings?.timezone||'Europe/Budapest'
      const {data:member}=await db.from('family_members')
        .select('family_id').eq('user_id',c.user_id).eq('member_kind','active').maybeSingle()
      if(!member)continue
      const refreshToken=await decryptRefreshToken(c.refresh_token_encrypted)
      const tokenRes=await fetch('https://oauth2.googleapis.com/token',{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({
          client_id:googleClientId,client_secret:googleClientSecret,
          refresh_token:refreshToken,grant_type:'refresh_token',
        }),signal:AbortSignal.timeout(8000),
      })
      if(!tokenRes.ok){
        const tokenError=await tokenRes.json().catch(()=>({})) as {error?:string}
        if(tokenError.error==='invalid_grant')await db.from('google_calendar_connections')
          .update({auto_import_enabled_at:null,auto_import_error:'reauthorize_required'})
          .eq('user_id',c.user_id).eq('refresh_token_encrypted',c.refresh_token_encrypted)
        output.push({scanned:false,error:'refresh_failed'})
        continue
      }
      const token=(await tokenRes.json() as {access_token?:string}).access_token
      if(!token){output.push({scanned:false,error:'no_access_token'});continue}

      // A végig beolvasott Google-válaszig nem léptetjük a kurzort.
      // Kétperces átfedés + (user,event) elsődleges kulcs = nincs duplikált push.
      const since=Math.max(Date.parse(c.auto_import_enabled_at),
        (c.auto_import_last_scanned_at?Date.parse(c.auto_import_last_scanned_at)-120_000:0))
      let pageToken:string|undefined
      let complete=true, found=0, pushed=0
      for(let page=0;page<10;page++){
        const u=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
        u.searchParams.set('updatedMin',new Date(since).toISOString())
        u.searchParams.set('maxResults','250')
        u.searchParams.set('singleEvents','false')
        u.searchParams.set('showDeleted','true')
        u.searchParams.set('eventTypes','default')
        if(pageToken)u.searchParams.set('pageToken',pageToken)
        const listRes=await fetch(u.toString(),{
          headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(12000),
        })
        if(!listRes.ok){complete=false;break}
        const result=await listRes.json() as {items?:Event[];nextPageToken?:string}
        for(const ev of result.items??[]){
          if(!ev.id || ev.recurringEventId || ev.recurrence?.length) continue
          // A régebben összekapcsolt események új verzióját külön jóváhagyásra
          // kínáljuk fel. A saját visszaírt változatok ETag-je egyezik, ezért
          // nem indítunk körkörös szinkronizálást.
          const {data:link,error:linkError}=await db.from('google_calendar_exports')
            .select('item_id,status,exported_at,sync_google_etag')
            .eq('user_id',c.user_id).eq('event_id',ev.id).maybeSingle()
          if(linkError){complete=false;break}
          if(link?.status==='sent'){
            const hasChanged=Boolean(ev.etag && (
              link.sync_google_etag
                ? ev.etag !== link.sync_google_etag
                : (ev.updated && Date.parse(ev.updated)>Date.parse(link.exported_at)+30000)
            ))
            if(hasChanged){
              const {data:localItem}=await db.from('items')
                .select('id,title,updated_at,status')
                .eq('id',link.item_id).eq('responsible_user_id',c.user_id).maybeSingle()
              if(localItem?.status==='open'){
                const changeType=ev.status==='cancelled'?'delete':'update'
                const startDate=ev.start?.dateTime?new Date(ev.start.dateTime):null
                const converted=startDate&&!Number.isNaN(startDate.getTime())
                  ?localParts(timeZone,startDate):null
                const date=converted?.date??ev.start?.date??null
                const eventTime=converted?.time??null
                if(changeType==='delete'||(ev.summary&&date)){
                  const {data:inserted,error:insertError}=await db
                    .from('google_calendar_change_candidates')
                    .insert({
                      user_id:c.user_id,event_id:ev.id,item_id:link.item_id,
                      google_etag:ev.etag,
                      change_type:changeType,
                      title:changeType==='delete'?localItem.title:ev.summary,
                      notes:changeType==='delete'?null:ev.description??null,
                      due_date:changeType==='delete'?null:date,
                      due_time:changeType==='delete'?null:eventTime,
                      item_updated_at:localItem.updated_at,
                      status:'pending',push_attempted_at:new Date().toISOString(),
                    }).select('id').maybeSingle()
                  if(insertError?.code!=='23505'&&(insertError||!inserted)){
                    complete=false;break
                  }
                  if(inserted){
                    found++
                    if(await notifyOnce(c.user_id,localItem.title,settings?.ui_locale??'hu-HU',changeType))pushed++
                  }
                }
              }
            }
            continue
          }
          if(ev.status==='cancelled'||!ev.summary||!ev.created||!ev.start)continue
          if(ev.extendedProperties?.private?.penzfa_item_id)continue
          if(Date.parse(ev.created)<Date.parse(c.auto_import_enabled_at))continue

          const dateTime=ev.start.dateTime?new Date(ev.start.dateTime):null
          if(dateTime&&Number.isNaN(dateTime.getTime()))continue
          const start=dateTime?localParts(timeZone,dateTime):null
          const dueDate=start?.date??ev.start.date
          const dueTime=start?.time??null
          if(!dueDate||dueDate<localParts(timeZone,now).date)continue

          if(link)continue

          const {data:stillConnected}=await db.from('google_calendar_connections')
            .select('auto_import_enabled_at').eq('user_id',c.user_id).maybeSingle()
          if(!stillConnected?.auto_import_enabled_at
            ||stillConnected.auto_import_enabled_at!==c.auto_import_enabled_at){complete=false;break}

          const discovered=new Date()
          const tomorrow=addDays(localParts(timeZone,discovered).date,1)
          const expiry=localMidnightUtc(addDays(tomorrow,1),timeZone)
          const {data:inserted,error:insertErr}=await db.from('google_calendar_import_candidates').insert({
            user_id:c.user_id,event_id:ev.id,
            title:ev.summary.slice(0,200),
            notes:ev.description?.slice(0,4000)??null,
            due_date:dueDate,due_time:dueTime,
            google_created_at:ev.created,
            discovered_at:discovered.toISOString(),
            briefing_date:tomorrow,expires_at:expiry,
            status:'pending',push_attempted_at:discovered.toISOString(),
          }).select('event_id').maybeSingle()
          if(insertErr?.code==='23505')continue
          if(insertErr||!inserted){complete=false;break}
          found++
          if(await notifyOnce(c.user_id,ev.summary.slice(0,100),settings?.ui_locale??'hu-HU'))pushed++
        }
        if(!complete)break
        if(!result.nextPageToken){pageToken=undefined;break}
        pageToken=result.nextPageToken
        if(page===9)complete=false
      }
      if(complete&&!pageToken){
        await db.from('google_calendar_connections')
          .update({auto_import_last_scanned_at:now.toISOString()})
          .eq('user_id',c.user_id).eq('auto_import_enabled_at',c.auto_import_enabled_at)
      }
      output.push({scanned:complete,found,pushed})
    }catch{
      // Hibánál nem lépünk tovább, az újabb kör a napló miatt nem küld dupla push-t.
      output.push({scanned:false,error:'scan_failed'})
    }
  }
  return json({status:'ok',connections:output.length,results:output})
})
