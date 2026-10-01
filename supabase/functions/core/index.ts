import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

type CreateInterpretation = {
  intent: 'create'
  title: string
  subject_name: string | null
  date_phrase: string | null
  time: string | null
  reminder_phrase: string | null
  item_type: 'task' | 'event' | 'deadline'
  notes: string | null
}

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

function normalize(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

function localDateInTimezone(timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function addDays(dateIso: string, days: number) {
  const [year, month, day] = dateIso.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function weekdayOf(dateIso: string) {
  const [year, month, day] = dateIso.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

function findHungarianWeekday(value: string) {
  const text = normalize(value)
  const weekdays: Array<[RegExp, number]> = [
    [/hetfo/, 1],
    [/kedd/, 2],
    [/szerda/, 3],
    [/csutortok/, 4],
    [/pentek/, 5],
    [/szombat/, 6],
    [/vasarnap/, 0],
  ]

  for (const [pattern, day] of weekdays) {
    if (pattern.test(text)) return day
  }

  return null
}

function resolveDatePhrase(phrase: string | null, timeZone: string) {
  if (!phrase) return null

  const raw = phrase.trim()
  const normalized = normalize(raw)
  const explicitIso = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/)
  if (explicitIso) return explicitIso[1]

  const today = localDateInTimezone(timeZone)

  if (/\bholnaputan\b/.test(normalized)) return addDays(today, 2)
  if (/\bholnap\b/.test(normalized)) return addDays(today, 1)
  if (/\bma\b/.test(normalized)) return today

  const targetWeekday = findHungarianWeekday(normalized)
  if (targetWeekday === null) return null

  const todayWeekday = weekdayOf(today)

  if (normalized.includes('jovo het') || normalized.includes('kovetkezo het')) {
    const daysToNextMonday = ((1 - todayWeekday + 7) % 7) || 7
    const targetOffsetFromMonday = (targetWeekday - 1 + 7) % 7
    return addDays(today, daysToNextMonday + targetOffsetFromMonday)
  }

  let delta = (targetWeekday - todayWeekday + 7) % 7
  if (delta === 0) delta = 7
  return addDays(today, delta)
}

function parseHungarianNumber(value: string) {
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric

  const words: Record<string, number> = {
    egy: 1,
    ket: 2,
    ketto: 2,
    harom: 3,
    negy: 4,
    ot: 5,
    hat: 6,
    het: 7,
    nyolc: 8,
    kilenc: 9,
    tiz: 10,
  }

  return words[normalize(value)] ?? null
}

function reminderDaysBefore(phrase: string | null) {
  if (!phrase) return null
  const text = normalize(phrase)

  const dayMatch = text.match(/(\d+|egy|ket|ketto|harom|negy|ot|hat|het|nyolc|kilenc|tiz)\s+nappal/)
  if (dayMatch) return parseHungarianNumber(dayMatch[1])

  const weekMatch = text.match(/(\d+|egy|ket|ketto|harom|negy|ot)\s+hettel/)
  if (weekMatch) {
    const weeks = parseHungarianNumber(weekMatch[1])
    return weeks === null ? null : weeks * 7
  }

  return null
}

function validateTime(value: string | null) {
  if (!value) return null
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  return match ? value : null
}

function localDateTimeToUtcIso(dateIso: string, time: string, timeZone: string) {
  const [year, month, day] = dateIso.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const desired = Date.UTC(year, month - 1, day, hour, minute)

  let guess = desired

  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(guess))

    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    const represented = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
    )

    guess += desired - represented
  }

  return new Date(guess).toISOString()
}

function formatHungarianDate(dateIso: string | null) {
  if (!dateIso) return 'dátum nélkül'
  const [year, month, day] = dateIso.split('-').map(Number)
  return new Intl.DateTimeFormat('hu-HU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

function extractOutputText(response: any) {
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        return content.text
      }
    }
  }
  return null
}

async function interpretWithOpenAI(
  message: string,
  memberNames: string[],
): Promise<CreateInterpretation> {
  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) throw new Error('OPENAI_API_KEY nincs beállítva a Supabase Edge Function secretjei között.')

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      instructions: [
        'Te egy magyar nyelvű családi asszisztens értelmező rétege vagy.',
        'Kizárólag strukturáld a felhasználó új bejegyzését. Ne írj adatbázisba és ne számolj ki relatív dátumot.',
        'A date_phrase mezőbe az eredeti relatív vagy konkrét dátumkifejezést tedd, például: "jövő kedden".',
        'A time mezőt HH:MM formára normalizálhatod, ha az időpont egyértelmű.',
        'A subject_name lehetőleg a megadott családtag-nevek egyikének alapalakja legyen.',
        `Ismert családtagok: ${memberNames.length ? memberNames.join(', ') : 'nincs'}.`,
        'A reminder_phrase maradjon természetes nyelvű, például: "három nappal előtte".',
        'A title rövid, természetes magyar megnevezés legyen.',
      ].join('\n'),
      input: message,
      text: {
        format: {
          type: 'json_schema',
          name: 'create_item_interpretation',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              intent: { type: 'string', enum: ['create'] },
              title: { type: 'string' },
              subject_name: { type: ['string', 'null'] },
              date_phrase: { type: ['string', 'null'] },
              time: { type: ['string', 'null'] },
              reminder_phrase: { type: ['string', 'null'] },
              item_type: { type: 'string', enum: ['task', 'event', 'deadline'] },
              notes: { type: ['string', 'null'] },
            },
            required: [
              'intent',
              'title',
              'subject_name',
              'date_phrase',
              'time',
              'reminder_phrase',
              'item_type',
              'notes',
            ],
          },
        },
      },
    }),
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data?.error?.message ?? 'OpenAI API hiba.')
  }

  const outputText = extractOutputText(data)
  if (!outputText) throw new Error('Az AI nem adott értelmezhető strukturált választ.')

  return JSON.parse(outputText) as CreateInterpretation
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Csak POST kérés támogatott.' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    if (body?.action === 'health') return json({ service: 'penzfa-core', status: 'ok' })

    const authorization = req.headers.get('Authorization')
    if (!authorization) return json({ error: 'Hiányzó Authorization fejléc.' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return json({ error: 'Hiányos Supabase Edge Function környezet.' }, 500)
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    })

    const { data: authData, error: authError } = await authClient.auth.getUser()
    if (authError || !authData.user) return json({ error: 'Érvénytelen vagy lejárt munkamenet.' }, 401)

    const user = authData.user
    const db = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: activeMembership } = await db
      .from('family_members')
      .select('id, family_id, display_name')
      .eq('user_id', user.id)
      .eq('member_kind', 'active')
      .maybeSingle()

    if (body?.action === 'bootstrap') {
      if (activeMembership) {
        return json({ status: 'exists', family_id: activeMembership.family_id })
      }

      const familyName = String(body?.family_name ?? '').trim()
      const displayName = String(body?.display_name ?? '').trim()
      const managedMembers = Array.isArray(body?.managed_members)
        ? body.managed_members.map((value: unknown) => String(value).trim()).filter(Boolean)
        : []

      if (!familyName || !displayName) {
        return json({ error: 'A család neve és a saját megjelenített név kötelező.' }, 400)
      }

      const { data: family, error: familyError } = await db
        .from('families')
        .insert({ name: familyName, created_by: user.id })
        .select('id')
        .single()

      if (familyError) throw familyError

      const members = [
        {
          family_id: family.id,
          user_id: user.id,
          display_name: displayName,
          member_kind: 'active',
        },
        ...managedMembers.map((name: string) => ({
          family_id: family.id,
          user_id: null,
          display_name: name,
          member_kind: 'managed',
        })),
      ]

      const { error: memberError } = await db.from('family_members').insert(members)
      if (memberError) {
        await db.from('families').delete().eq('id', family.id)
        throw memberError
      }

      await db.from('user_settings').upsert({ user_id: user.id })
      await db.from('activity_log').insert({
        family_id: family.id,
        actor_user_id: user.id,
        action: 'family_bootstrap_created',
        details: { managed_members: managedMembers },
      })

      return json({ status: 'created', family_id: family.id })
    }

    if (!activeMembership) {
      return json({ error: 'Előbb hozd létre a családot.', code: 'SETUP_REQUIRED' }, 409)
    }

    const familyId = activeMembership.family_id

    if (body?.action === 'interpret_create') {
      const message = String(body?.message ?? '').trim()
      if (!message) return json({ error: 'Az üzenet nem lehet üres.' }, 400)

      const [{ data: members, error: membersError }, { data: settings }] = await Promise.all([
        db
          .from('family_members')
          .select('id, display_name, member_kind, user_id')
          .eq('family_id', familyId),
        db
          .from('user_settings')
          .select('timezone, briefing_time')
          .eq('user_id', user.id)
          .maybeSingle(),
      ])

      if (membersError) throw membersError

      const interpretation = await interpretWithOpenAI(
        message,
        (members ?? []).map((member) => member.display_name),
      )

      const timeZone = settings?.timezone ?? 'Europe/Budapest'
      const briefingTime = String(settings?.briefing_time ?? '07:00:00').slice(0, 5)
      const dueDate = resolveDatePhrase(interpretation.date_phrase, timeZone)
      const dueTime = validateTime(interpretation.time)

      if (interpretation.date_phrase && !dueDate) {
        return json({
          error: 'A dátumot még nem tudom biztonságosan feloldani.',
          code: 'DATE_NEEDS_CLARIFICATION',
          date_phrase: interpretation.date_phrase,
        }, 422)
      }

      let subject = null
      if (interpretation.subject_name) {
        const wanted = normalize(interpretation.subject_name)
        subject = (members ?? []).find((member) => normalize(member.display_name) === wanted) ?? null

        if (!subject) {
          return json({
            error: `Nem találtam ilyen családtagot: ${interpretation.subject_name}.`,
            code: 'SUBJECT_NEEDS_CLARIFICATION',
            subject_name: interpretation.subject_name,
            known_members: (members ?? []).map((member) => member.display_name),
          }, 422)
        }
      }

      const reminderOffsetDays = reminderDaysBefore(interpretation.reminder_phrase)
      let firstReminderAt: string | null = null

      if (interpretation.reminder_phrase) {
        if (!dueDate || reminderOffsetDays === null) {
          return json({
            error: 'Az emlékeztetés időpontját még pontosítani kell.',
            code: 'REMINDER_NEEDS_CLARIFICATION',
            reminder_phrase: interpretation.reminder_phrase,
          }, 422)
        }

        const reminderDate = addDays(dueDate, -reminderOffsetDays)
        firstReminderAt = localDateTimeToUtcIso(reminderDate, briefingTime, timeZone)
      }

      const dateText = formatHungarianDate(dueDate)
      const timeText = dueTime ? ` ${dueTime}` : ''
      const subjectText = subject ? `${subject.display_name}: ` : ''
      const reminderText = interpretation.reminder_phrase
        ? ` Emlékeztetés: ${interpretation.reminder_phrase}.`
        : ' Emlékeztetést még nem adtál meg.'

      const draft: CreateDraft = {
        subject_member_id: subject?.id ?? null,
        subject_display_name: subject?.display_name ?? null,
        title: interpretation.title,
        item_type: interpretation.item_type,
        notes: interpretation.notes,
        due_date: dueDate,
        due_time: dueTime,
        first_reminder_at: firstReminderAt,
        reminder_phrase: interpretation.reminder_phrase,
        confirmation_text: `${subjectText}${interpretation.title} – ${dateText}${timeText}.${reminderText} Rögzítsem?`,
      }

      return json({ status: 'needs_confirmation', draft })
    }

    if (body?.action === 'confirm_create') {
      const draft = body?.draft as CreateDraft | undefined
      if (!draft || !draft.title || !draft.item_type) {
        return json({ error: 'Hiányos létrehozási tervezet.' }, 400)
      }

      if (draft.subject_member_id) {
        const { data: subject } = await db
          .from('family_members')
          .select('id')
          .eq('id', draft.subject_member_id)
          .eq('family_id', familyId)
          .maybeSingle()

        if (!subject) return json({ error: 'A megadott családtag nem ehhez a családhoz tartozik.' }, 400)
      }

      const { data: item, error: itemError } = await db
        .from('items')
        .insert({
          family_id: familyId,
          subject_member_id: draft.subject_member_id,
          responsible_user_id: user.id,
          item_type: draft.item_type,
          title: draft.title,
          notes: draft.notes,
          due_date: draft.due_date,
          due_time: draft.due_time,
          created_by: user.id,
        })
        .select('*')
        .single()

      if (itemError) throw itemError

      if (draft.first_reminder_at) {
        const { error: reminderError } = await db.from('reminders').insert({
          item_id: item.id,
          first_reminder_at: draft.first_reminder_at,
          next_notification_at: draft.first_reminder_at,
        })

        if (reminderError) {
          await db.from('items').delete().eq('id', item.id)
          throw reminderError
        }
      }

      await db.from('activity_log').insert({
        family_id: familyId,
        actor_user_id: user.id,
        item_id: item.id,
        action: 'item_created',
        details: {
          due_date: item.due_date,
          due_time: item.due_time,
          reminder_phrase: draft.reminder_phrase,
        },
      })

      return json({ status: 'created', item })
    }

    return json({ error: 'Ismeretlen művelet.' }, 400)
  } catch (error) {
    console.error(error)
    return json({
      error: error instanceof Error ? error.message : 'Ismeretlen szerverhiba.',
    }, 500)
  }
})
