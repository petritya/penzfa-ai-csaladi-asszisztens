import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Csak POST kérés támogatott.' }, 405)

  try {
    const authorization = req.headers.get('Authorization')
    if (!authorization) return json({ error: 'Hiányzó munkamenet.' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const openAiKey = Deno.env.get('OPENAI_API_KEY')

    if (!supabaseUrl || !anonKey || !openAiKey) {
      return json({ error: 'Hiányos szerverkonfiguráció.' }, 500)
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    })

    const { data: authData, error: authError } = await authClient.auth.getUser()
    if (authError || !authData.user) return json({ error: 'Érvénytelen vagy lejárt munkamenet.' }, 401)

    let openItemTitles = ''
    try {
      const { data: membership } = await authClient
        .from('family_members')
        .select('family_id')
        .eq('user_id', authData.user.id)
        .eq('member_kind', 'active')
        .limit(1)
        .maybeSingle()

      if (membership?.family_id) {
        const { data: openItems } = await authClient
          .from('items')
          .select('title')
          .eq('family_id', membership.family_id)
          .eq('status', 'open')
          .order('created_at', { ascending: false })
          .limit(25)

        openItemTitles = (openItems ?? [])
          .map((item) => String(item.title ?? '').trim())
          .filter(Boolean)
          .join('; ')
      }
    } catch {
      openItemTitles = ''
    }

    const form = await req.formData()
    const audio = form.get('file')
    const memberNames = String(form.get('member_names') ?? '').trim()
    const language = form.get('language') === 'da' ? 'da' : 'hu'

    if (!(audio instanceof File) || audio.size === 0) {
      return json({ error: language === 'da' ? 'Lydoptagelsen mangler.' : 'Hiányzó hangfelvétel.' }, 400)
    }

    if (audio.size > 10 * 1024 * 1024) {
      return json({ error: language === 'da' ? 'Lydoptagelsen er for stor.' : 'A hangfelvétel túl nagy.' }, 413)
    }

    console.log(JSON.stringify({
      event: 'transcribe_request',
      audio_size: audio.size,
      audio_type: audio.type || 'unknown',
      language,
    }))

    const openAiForm = new FormData()
    // A MediaRecorder MIME-ja lehet audio/webm;codecs=opus. A fájlnév és az
    // egyszerű MIME-típus egyezzen meg a feltöltött audio tényleges formátumával.
    const cleanAudioType = audio.type.split(';')[0].trim() || 'audio/webm'
    const audioFile = new File([audio], audio.name || 'penzfa-voice.webm', { type: cleanAudioType })
    openAiForm.append('file', audioFile, audioFile.name)
    openAiForm.append('model', 'gpt-4o-transcribe')
    openAiForm.append('language', language)
    openAiForm.append(
      'prompt',
      language === 'da'
        ? [
          'Dansk tale til en familieassistent: opgaver, aftaler, påmindelser og spørgsmål.',
          memberNames ? `Familiemedlemmernes præcise navne: ${memberNames}.` : '',
          openItemTitles ? `Eksisterende opgavetitler, kun som lydkontekst: ${openItemTitles}.` : '',
          'Skriv navne nøjagtigt som udtalt. Udfyld ikke manglende oplysninger.',
          'Eksempler på dato- og tidsord: i dag, i morgen, næste tirsdag, på fredag, klokken ti, halv elleve.',
          'Transskriber dansk ordret. Bevar tal, tidspunkter, negationer og betydning. Oversæt ikke til ungarsk.',
          'Eksisterende titler er kun hjælpeord og må ikke ændre betydningen af optagelsen.',
        ].filter(Boolean).join(' ')
        : [
          'Magyar nyelvű családi asszisztensnek diktált rövid teendők és kérdések.',
          memberNames ? `A családtagok pontos nevei: ${memberNames}.` : '',
          openItemTitles ? `Aktuális nyitott ügyek címei, kizárólag akusztikai kontextusnak: ${openItemTitles}.` : '',
          'A családtagok nevét pontosan írd le.',
          'A nyitott ügyek címei csak háttérszókincs: csak akkor használd őket, ha a hang alapján is hihetőek. Ne alakítsd át a beszédet azért, hogy valamelyik ügycímhez illeszkedjen.',
          'Gyakori időszavak és dátumszavak: ma, holnap, tegnap, hétfő, kedd, szerda, csütörtök, péntek, szombat, vasárnap, jövő héten.',
          'Gyakori időpontok: 8-kor, 9-kor, 10-kor, 16-kor, 18-kor. A kimondott számot pontosan írd le, ne következtess másik időpontra.',
          'Az időpontokat lehetőleg számjegyes HH:MM formában írd át. Példák: "tíz harminc" vagy "fél tizenegy" => 10:30; "tíz óra" => 10:00; "negyed tizenegy" => 10:15.',
          'Relatív időtartamot ne alakíts abszolút időponttá: "fél órával előtte" maradjon "fél órával előtte".',
          'Gyakori lezáró igék: felhívtam, elintéztem, befizettem, elküldtem, átvettem, lefoglaltam.',
          'Különösen ügyelj a felhívtam igére: ha a hang és a nyitott ügyek kontextusa telefonhívásra utal, ne írd át elhívtam alakra.',
          'A beszédet szó szerint írd át; ne javítsd át más jelentésű szóra és ne egészítsd ki találgatással.',
        ].filter(Boolean).join(' '),
    )

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAiKey}`,
      },
      body: openAiForm,
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      console.error(JSON.stringify({
        event: 'transcribe_upstream_error',
        upstream_status: response.status,
        upstream_code: data?.error?.code ?? null,
        upstream_param: data?.error?.param ?? null,
        upstream_request_id: response.headers.get('x-request-id'),
        audio_size: audio.size,
        audio_type: cleanAudioType,
      }))
      // A hibás/értelmezhetetlen hangot nem segít azonnal ugyanazzal az
      // adattal újraküldeni. A szerverhibáknál marad a kliens újrapróbálása.
      const invalidAudio = response.status === 400
      return json({
        error: invalidAudio
          ? (language === 'da'
            ? 'Lydoptagelsen kunne ikke behandles. Prøv at optage igen.'
            : 'A hangfelvételt nem sikerült feldolgozni. Kérlek, diktáld be újra.')
          : (language === 'da' ? 'Lydgenkendelsen er midlertidigt utilgængelig.' : 'A hangfelismerés átmenetileg nem érhető el.'),
      }, invalidAudio ? 422 : 502)
    }

    const text = String(data?.text ?? '').trim()
    if (!text) {
      console.warn(JSON.stringify({
        event: 'transcribe_empty',
        audio_size: audio.size,
        audio_type: audio.type || 'unknown',
      }))
      return json({
        error: language === 'da'
          ? 'Der kunne ikke genkendes tale i optagelsen.'
          : 'Nem sikerült beszédet felismerni a felvételen.',
      }, 422)
    }

    console.log(JSON.stringify({
      event: 'transcribe_success',
      audio_size: audio.size,
      audio_type: audio.type || 'unknown',
    }))

    return json({ status: 'ok', text })
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : 'Ismeretlen hangfelismerési hiba.',
    }, 500)
  }
})
