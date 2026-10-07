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

    const form = await req.formData()
    const audio = form.get('file')
    const memberNames = String(form.get('member_names') ?? '').trim()

    if (!(audio instanceof File) || audio.size === 0) {
      return json({ error: 'Hiányzó hangfelvétel.' }, 400)
    }

    if (audio.size > 10 * 1024 * 1024) {
      return json({ error: 'A hangfelvétel túl nagy.' }, 413)
    }

    const openAiForm = new FormData()
    openAiForm.append('file', audio, audio.name || 'penzfa-voice.webm')
    openAiForm.append('model', 'gpt-4o-transcribe')
    openAiForm.append('language', 'hu')
    openAiForm.append(
      'prompt',
      [
        'Magyar nyelvű családi asszisztensnek diktált rövid teendők és kérdések.',
        memberNames ? `A családtagok pontos nevei: ${memberNames}.` : '',
        'A családtagok nevét pontosan írd le.',
        'Gyakori időszavak és dátumszavak: ma, holnap, tegnap, hétfő, kedd, szerda, csütörtök, péntek, szombat, vasárnap, jövő héten.',
        'Gyakori időpontok: 8-kor, 9-kor, 10-kor, 16-kor, 18-kor. A kimondott számot pontosan írd le, ne következtess másik időpontra.',
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
      return json({ error: data?.error?.message ?? 'A hang átírása nem sikerült.' }, 502)
    }

    const text = String(data?.text ?? '').trim()
    if (!text) return json({ error: 'Nem sikerült beszédet felismerni a felvételen.' }, 422)

    return json({ status: 'ok', text })
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : 'Ismeretlen hangfelismerési hiba.',
    }, 500)
  }
})
