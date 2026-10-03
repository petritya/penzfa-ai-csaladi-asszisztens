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

type UpdateInterpretation = {
  intent: 'update'
  target_title: string
  subject_name: string | null
  target_date_phrase: string | null
  new_date_phrase: string | null
  new_time: string | null
  new_title: string | null
}

type UpdateCandidate = {
  id: string
  title: string
  due_date: string | null
  due_time: string | null
  subject_display_name: string | null
}

type UpdateDraft = {
  pending_action_id: string
  target_item_id: string
  confirmation_text: string
}

type CompleteInterpretation = {
  intent: 'complete'
  target_title: string
  subject_name: string | null
  target_date_phrase: string | null
}

type CompleteDraft = {
  pending_action_id: string
  target_item_id: string
  confirmation_text: string
}

type QueryInterpretation = {
  intent: 'query'
  status: 'open' | 'done' | 'all'
  responsibility: 'mine' | 'family'
  subject_name: string | null
  responsible_name: string | null
  keywords: string | null
  date_scope: 'none' | 'today' | 'tomorrow' | 'this_week' | 'next_7_days' | 'specific_date'
  date_phrase: string | null
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

async function sendOwnerInvite(
  dbClient: any,
  email: string,
  redirectTo?: string | null,
) {
  const options = redirectTo
    ? { redirectTo }
    : undefined

  const { data, error } = await dbClient.auth.admin.inviteUserByEmail(email, options)

  if (error || !data?.user?.id) {
    throw new Error(error?.message ?? 'Nem sikerült elküldeni a második ügygazda meghívóját.')
  }

  return data.user.id as string
}

function normalize(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

function duplicateTitleKey(value: string) {
  return normalize(value).replace(/[^a-z0-9]+/g, '')
}

async function findExactOpenDuplicate(
  dbClient: any,
  familyId: string,
  title: string,
  dueDate: string | null,
  dueTime: string | null,
  subjectMemberId: string | null,
) {
  let query = dbClient
    .from('items')
    .select('id, title, due_date, due_time, subject_member_id')
    .eq('family_id', familyId)
    .eq('status', 'open')

  query = dueDate
    ? query.eq('due_date', dueDate)
    : query.is('due_date', null)

  const { data: candidates, error } = await query.limit(50)
  if (error) throw error

  const wantedTitle = duplicateTitleKey(title)
  const wantedTime = dueTime ? String(dueTime).slice(0, 5) : null
  const wantedSubject = subjectMemberId ?? null

  return (candidates ?? []).find((item) => {
    const itemTime = item.due_time ? String(item.due_time).slice(0, 5) : null
    return duplicateTitleKey(item.title) === wantedTitle
      && itemTime === wantedTime
      && (item.subject_member_id ?? null) === wantedSubject
  }) ?? null
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

function makeIsoDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null

  return date.toISOString().slice(0, 10)
}

function findHungarianMonth(value: string) {
  const text = normalize(value)
  const months: Array<[string, number]> = [
    ['januar', 1],
    ['februar', 2],
    ['marcius', 3],
    ['aprilis', 4],
    ['majus', 5],
    ['junius', 6],
    ['julius', 7],
    ['augusztus', 8],
    ['szeptember', 9],
    ['oktober', 10],
    ['november', 11],
    ['december', 12],
  ]

  for (const [name, month] of months) {
    if (text.includes(name)) return month
  }

  return null
}

function findDayOfMonth(value: string) {
  const text = normalize(value)

  const numeric = text.match(/\b([12]?\d|3[01])(?:\.|-(?:an|en))?\b/)
  if (numeric) return Number(numeric[1])

  const ordinals: Array<[RegExp, number]> = [
    [/\belsejen\b/, 1],
    [/\bmasodikan\b/, 2],
    [/\bharmadikan\b/, 3],
    [/\bnegyediken\b/, 4],
    [/\botodiken\b/, 5],
    [/\bhatodikan\b/, 6],
    [/\bhetediken\b/, 7],
    [/\bnyolcadikan\b/, 8],
    [/\bkilencediken\b/, 9],
    [/\btizediken\b/, 10],
  ]

  for (const [pattern, day] of ordinals) {
    if (pattern.test(text)) return day
  }

  return null
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
  const [todayYear, todayMonth] = today.split('-').map(Number)

  const explicitMonth = findHungarianMonth(raw)
  const explicitDay = findDayOfMonth(raw)

  if (explicitMonth !== null && explicitDay !== null) {
    let year = todayYear
    let candidate = makeIsoDate(year, explicitMonth, explicitDay)
    if (!candidate) return null
    if (candidate < today) {
      year += 1
      candidate = makeIsoDate(year, explicitMonth, explicitDay)
    }
    return candidate
  }

  if (explicitMonth === null && explicitDay !== null) {
    let year = todayYear
    let month = todayMonth
    let candidate = makeIsoDate(year, month, explicitDay)

    if (!candidate || candidate < today) {
      month += 1
      if (month > 12) {
        month = 1
        year += 1
      }
      candidate = makeIsoDate(year, month, explicitDay)
    }

    return candidate
  }

  if (/\bholnaputan\b/.test(normalized)) return addDays(today, 2)
  if (/\bholnap\b/.test(normalized)) return addDays(today, 1)
  if (/\bma\b/.test(normalized)) return today

  const weeksWithWeekdayMatch = normalized.match(
    /\b(\d+|egy|ket|ketto|harom|negy|ot|hat|het|nyolc|kilenc|tiz)\s+het\s+mulva\b/,
  )
  const weekdayInPhrase = findHungarianWeekday(normalized)

  if (weeksWithWeekdayMatch && weekdayInPhrase !== null) {
    const weeks = parseHungarianNumber(weeksWithWeekdayMatch[1])
    if (weeks !== null && weeks >= 1) {
      const todayWeekday = weekdayOf(today)
      const daysToNextMonday = ((1 - todayWeekday + 7) % 7) || 7
      const targetOffsetFromMonday = (weekdayInPhrase - 1 + 7) % 7
      return addDays(today, daysToNextMonday + (weeks - 1) * 7 + targetOffsetFromMonday)
    }
  }

  const relativeMatch = normalized.match(
    /\b(\d+|egy|ket|ketto|harom|negy|ot|hat|het|nyolc|kilenc|tiz)\s+(nap|het)\s+mulva\b/,
  )
  if (relativeMatch) {
    const amount = parseHungarianNumber(relativeMatch[1])
    if (amount !== null) {
      const multiplier = relativeMatch[2] === 'het' ? 7 : 1
      return addDays(today, amount * multiplier)
    }
  }

  const targetWeekday = weekdayInPhrase
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

function dateInTimezone(isoTimestamp: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(isoTimestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function timeInTimezone(isoTimestamp: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(isoTimestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.hour}:${values.minute}`
}

function daysBetween(fromDateIso: string, toDateIso: string) {
  const [fy, fm, fd] = fromDateIso.split('-').map(Number)
  const [ty, tm, td] = toDateIso.split('-').map(Number)
  const diff = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)
  return Math.round(diff / 86400000)
}

function resolveQueryDateRange(
  scope: QueryInterpretation['date_scope'],
  phrase: string | null,
  timeZone: string,
) {
  const today = localDateInTimezone(timeZone)

  if (scope === 'none') return null
  if (scope === 'today') return { start: today, end: today }
  if (scope === 'tomorrow') {
    const date = addDays(today, 1)
    return { start: date, end: date }
  }
  if (scope === 'next_7_days') {
    return { start: today, end: addDays(today, 6) }
  }
  if (scope === 'this_week') {
    const weekday = weekdayOf(today)
    const daysFromMonday = (weekday + 6) % 7
    const start = addDays(today, -daysFromMonday)
    return { start, end: addDays(start, 6) }
  }

  const date = resolveDatePhrase(phrase, timeZone)
  return date ? { start: date, end: date } : null
}

function queryItemDate(item: any, timeZone: string) {
  if (item.status === 'done' && item.completed_at) {
    return dateInTimezone(item.completed_at, timeZone)
  }
  return item.due_date ?? null
}

function queryItemLine(
  item: any,
  memberName: string | null,
  responsibleName: string | null,
  timeZone: string,
  showResponsible = false,
  ownerPrefixName: string | null = null,
) {
  const ownerPrefix = ownerPrefixName ? `${ownerPrefixName}: ` : ''
  const subject = memberName
    && (!ownerPrefixName || normalize(memberName) !== normalize(ownerPrefixName))
      ? ownerPrefixName
        ? `${memberName} – `
        : `${memberName}: `
      : ''
  const time = item.due_time ? ` ${String(item.due_time).slice(0, 5)}` : ''
  const responsible = showResponsible && responsibleName
    ? ` – felelős: ${responsibleName}`
    : ''

  if (item.status === 'done') {
    const completedDate = item.completed_at
      ? dateInTimezone(item.completed_at, timeZone)
      : null
    return `✓ ${ownerPrefix}${subject}${item.title}${completedDate ? ` – elintézve: ${formatHungarianDate(completedDate)}` : ''}${responsible}`
  }

  return `• ${ownerPrefix}${subject}${item.title}${item.due_date ? ` – ${formatHungarianDate(item.due_date)}${time}` : ' – dátum nélkül'}${responsible}`
}

function updateCandidateLabel(candidate: UpdateCandidate) {
  const subject = candidate.subject_display_name ? `${candidate.subject_display_name}: ` : ''
  const date = candidate.due_date ? formatHungarianDate(candidate.due_date) : 'dátum nélkül'
  const time = candidate.due_time ? ` ${String(candidate.due_time).slice(0, 5)}` : ''
  return `${subject}${candidate.title} – ${date}${time}`
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


async function interpretUpdateWithOpenAI(
  message: string,
  memberNames: string[],
): Promise<UpdateInterpretation> {
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
        'Te egy magyar nyelvű családi asszisztens módosítás-értelmező rétege vagy.',
        'A felhasználó egy már létező családi ügyet akar módosítani.',
        'Ne módosíts adatbázist és ne találj ki hiányzó adatot.',
        'A target_title legyen rövid, alapalakú megnevezés, amely alapján a meglévő ügy megkereshető, például "Fodrász".',
        'A subject_name lehetőleg a megadott családtag-nevek egyikének alapalakja legyen.',
        `Ismert családtagok: ${memberNames.length ? memberNames.join(', ') : 'nincs'}.`,
        'A target_date_phrase csak akkor legyen kitöltve, ha a felhasználó a régi eseményt dátummal azonosítja.',
        'A new_date_phrase csak az új dátumra vonatkozó természetes nyelvű kifejezés legyen.',
        'Ha azt mondja, hogy ugyanazon a napon marad, a new_date_phrase legyen null.',
        'A new_time mezőt HH:MM formára normalizáld, ha új időpont egyértelmű.',
        'Ha új címet nem kér, new_title legyen null.',
      ].join('\n'),
      input: message,
      text: {
        format: {
          type: 'json_schema',
          name: 'update_item_interpretation',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              intent: { type: 'string', enum: ['update'] },
              target_title: { type: 'string' },
              subject_name: { type: ['string', 'null'] },
              target_date_phrase: { type: ['string', 'null'] },
              new_date_phrase: { type: ['string', 'null'] },
              new_time: { type: ['string', 'null'] },
              new_title: { type: ['string', 'null'] },
            },
            required: [
              'intent',
              'target_title',
              'subject_name',
              'target_date_phrase',
              'new_date_phrase',
              'new_time',
              'new_title',
            ],
          },
        },
      },
    }),
  })

  const data = await response.json()
  if (!response.ok) throw new Error(data?.error?.message ?? 'OpenAI API hiba.')

  const outputText = extractOutputText(data)
  if (!outputText) throw new Error('Az AI nem adott értelmezhető módosítási választ.')

  return JSON.parse(outputText) as UpdateInterpretation
}


async function interpretCompleteWithOpenAI(
  message: string,
  memberNames: string[],
): Promise<CompleteInterpretation> {
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
        'Te egy magyar nyelvű családi asszisztens lezárás-értelmező rétege vagy.',
        'A felhasználó azt jelzi, hogy egy már létező nyitott ügy elkészült vagy el lett intézve.',
        'Ne módosíts adatbázist és ne találj ki hiányzó adatot.',
        'A target_title legyen rövid, alapalakú megnevezés, amely alapján a meglévő ügy megkereshető.',
        'A subject_name lehetőleg a megadott családtag-nevek egyikének alapalakja legyen.',
        `Ismert családtagok: ${memberNames.length ? memberNames.join(', ') : 'nincs'}.`,
        'A target_date_phrase csak akkor legyen kitöltve, ha a felhasználó dátummal azonosítja, melyik ügy készült el.',
      ].join('\n'),
      input: message,
      text: {
        format: {
          type: 'json_schema',
          name: 'complete_item_interpretation',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              intent: { type: 'string', enum: ['complete'] },
              target_title: { type: 'string' },
              subject_name: { type: ['string', 'null'] },
              target_date_phrase: { type: ['string', 'null'] },
            },
            required: ['intent', 'target_title', 'subject_name', 'target_date_phrase'],
          },
        },
      },
    }),
  })

  const data = await response.json()
  if (!response.ok) throw new Error(data?.error?.message ?? 'OpenAI API hiba.')

  const outputText = extractOutputText(data)
  if (!outputText) throw new Error('Az AI nem adott értelmezhető lezárási választ.')

  return JSON.parse(outputText) as CompleteInterpretation
}

async function interpretQueryWithOpenAI(
  message: string,
  activeMemberNames: string[],
  managedMemberNames: string[],
): Promise<QueryInterpretation> {
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
        'Te egy magyar nyelvű családi asszisztens lekérdezés-értelmező rétege vagy.',
        'Csak a keresési szándékot strukturáld. Ne kérdezz adatbázist és ne számolj relatív dátumot.',
        'status=open: nyitott vagy jövőbeli ügyek; done: elintézett/kész előzmények; all: csak ha a kérdés tényleg mindkettőt kéri.',
        'responsibility=mine, ha a felhasználó kifejezetten a saját felelősségi körére kérdez (pl. "ami hozzám tartozik", "az én feladataim"). Egyébként family.',
        `Aktív felnőttek: ${activeMemberNames.length ? activeMemberNames.join(', ') : 'nincs'}.`,
        `Kezelt családtagok: ${managedMemberNames.length ? managedMemberNames.join(', ') : 'nincs'}.`,
        'subject_name azt jelenti, hogy kire vonatkozik az ügy. Kezelt családtagnál általában ezt használd.',
        'responsible_name azt jelenti, hogy melyik aktív felnőtt felelős az ügyért. Csak aktív felnőtt neve kerülhet ide.',
        'Ha azt kérdezik, hogy egy aktív felnőttnek milyen feladatai/ügyei vannak, responsible_name legyen az ő neve.',
        'Ha azt kérdezik, hogy egy kezelt családtagnak (gyerek, nagyszülő) milyen ügyei vannak, subject_name legyen az ő neve.',
        'Ha konkrét eseményre kérdeznek rá, például "Mikor megy Anya fodrászhoz?", az esemény alanya legyen subject_name, akkor is, ha aktív felnőtt.',
        'A subject_name és responsible_name egyszerre is kitölthető, például "Mamus ügyei, amik Anyához tartoznak".',
        'keywords legyen rövid keresőkifejezés, például "fodrász", ha konkrét ügytípust keres. Általános listázásnál legyen null.',
        'date_scope: today, tomorrow, this_week, next_7_days, specific_date vagy none.',
        'specific_date esetén a date_phrase őrizze meg az eredeti dátumkifejezést. Más scope esetén date_phrase legyen null.',
        'Példák: "Mi van holnap?" => open, family, subject_name=null, responsible_name=null, tomorrow.',
        '"Mikor megy Anya fodrászhoz?" => open, family, subject_name=Anya, responsible_name=null, keywords=fodrász, none.',
        '"Milyen nyitott ügyeim vannak?" => open, mine, subject_name=null, responsible_name=null, none.',
        '"Mit intéztem el ezen a héten?" => done, mine, subject_name=null, responsible_name=null, this_week.',
        '"Mamusnak milyen ügyei vannak?" => open, family, subject_name=Mamus, responsible_name=null, none.',
        '"Mamus melyik ügyei tartoznak hozzám?" => open, mine, subject_name=Mamus, responsible_name=null, none.',
        '"Mamus melyik ügyei tartoznak Anyához?" => open, family, subject_name=Mamus, responsible_name=Anya, none.',
      ].join('\n'),
      input: message,
      text: {
        format: {
          type: 'json_schema',
          name: 'query_items_interpretation',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              intent: { type: 'string', enum: ['query'] },
              status: { type: 'string', enum: ['open', 'done', 'all'] },
              responsibility: { type: 'string', enum: ['mine', 'family'] },
              subject_name: { type: ['string', 'null'] },
              responsible_name: { type: ['string', 'null'] },
              keywords: { type: ['string', 'null'] },
              date_scope: {
                type: 'string',
                enum: ['none', 'today', 'tomorrow', 'this_week', 'next_7_days', 'specific_date'],
              },
              date_phrase: { type: ['string', 'null'] },
            },
            required: [
              'intent',
              'status',
              'responsibility',
              'subject_name',
              'responsible_name',
              'keywords',
              'date_scope',
              'date_phrase',
            ],
          },
        },
      },
    }),
  })

  const data = await response.json()
  if (!response.ok) throw new Error(data?.error?.message ?? 'OpenAI API hiba.')

  const outputText = extractOutputText(data)
  if (!outputText) throw new Error('Az AI nem adott értelmezhető keresési választ.')

  return JSON.parse(outputText) as QueryInterpretation
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

    if (body?.action === 'setup_status') {
      if (activeMembership) {
        return json({
          setup_complete: true,
          family_id: activeMembership.family_id,
          pending_owner_invitation: false,
        })
      }

      let invitationQuery = db
        .from('family_owner_invitations')
        .select('id, family_id, status, families(name)')
        .eq('status', 'pending')

      if (user.id) {
        invitationQuery = invitationQuery.eq('invited_user_id', user.id)
      }

      let { data: pendingInvitation, error: invitationLookupError } =
        await invitationQuery.maybeSingle()

      if ((!pendingInvitation || invitationLookupError) && user.email) {
        const fallback = await db
          .from('family_owner_invitations')
          .select('id, family_id, status, families(name)')
          .eq('status', 'pending')
          .ilike('email', user.email)
          .maybeSingle()

        pendingInvitation = fallback.data
        invitationLookupError = fallback.error
      }

      if (invitationLookupError) throw invitationLookupError

      return json({
        setup_complete: false,
        family_id: null,
        pending_owner_invitation: Boolean(pendingInvitation),
        invitation_family_id: pendingInvitation?.family_id ?? null,
        invitation_family_name: (pendingInvitation as any)?.families?.name ?? null,
      })
    }

    if (body?.action === 'accept_owner_invitation') {
      if (activeMembership) {
        return json({ status: 'already_active', family_id: activeMembership.family_id })
      }

      const displayName = String(body?.display_name ?? '').trim()
      if (!displayName) {
        return json({ error: 'A megjelenített név kötelező.' }, 400)
      }

      let invitationQuery = db
        .from('family_owner_invitations')
        .select('id, family_id, email, invited_user_id, status')
        .eq('status', 'pending')

      if (user.id) invitationQuery = invitationQuery.eq('invited_user_id', user.id)

      let { data: invitation, error: invitationError } = await invitationQuery.maybeSingle()

      if ((!invitation || invitationError) && user.email) {
        const fallback = await db
          .from('family_owner_invitations')
          .select('id, family_id, email, invited_user_id, status')
          .eq('status', 'pending')
          .ilike('email', user.email)
          .maybeSingle()

        invitation = fallback.data
        invitationError = fallback.error
      }

      if (invitationError) throw invitationError
      if (!invitation) {
        return json({ error: 'Nem találtam érvényes ügygazda-meghívást ehhez a fiókhoz.' }, 404)
      }

      const { count: activeOwnerCount, error: ownerCountError } = await db
        .from('family_members')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', invitation.family_id)
        .eq('member_kind', 'active')

      if (ownerCountError) throw ownerCountError
      if ((activeOwnerCount ?? 0) >= 2) {
        return json({ error: 'Ebben a családban már megvan a két ügygazda.' }, 409)
      }

      const { data: familyMembers, error: familyMembersError } = await db
        .from('family_members')
        .select('id, display_name, member_kind, user_id')
        .eq('family_id', invitation.family_id)

      if (familyMembersError) throw familyMembersError

      const nameKey = normalize(displayName)
      const existingActiveName = (familyMembers ?? []).find((member) =>
        member.member_kind === 'active'
        && normalize(member.display_name) === nameKey
      )

      if (existingActiveName) {
        return json({ error: 'Ez a megjelenített név már egy másik ügygazdához tartozik.' }, 409)
      }

      const matchingManaged = (familyMembers ?? []).find((member) =>
        member.member_kind === 'managed'
        && normalize(member.display_name) === nameKey
      )

      let memberId: string
      let transferredOpenItems = 0

      if (matchingManaged) {
        const { data: promoted, error: promoteError } = await db
          .from('family_members')
          .update({
            member_kind: 'active',
            user_id: user.id,
          })
          .eq('id', matchingManaged.id)
          .eq('family_id', invitation.family_id)
          .eq('member_kind', 'managed')
          .select('id')
          .single()

        if (promoteError) throw promoteError
        memberId = promoted.id

        const { data: transferredItems, error: transferError } = await db
          .from('items')
          .update({ responsible_user_id: user.id })
          .eq('family_id', invitation.family_id)
          .eq('subject_member_id', matchingManaged.id)
          .eq('status', 'open')
          .select('id')

        if (transferError) throw transferError
        transferredOpenItems = transferredItems?.length ?? 0
      } else {
        const { data: inserted, error: insertError } = await db
          .from('family_members')
          .insert({
            family_id: invitation.family_id,
            user_id: user.id,
            display_name: displayName,
            member_kind: 'active',
          })
          .select('id')
          .single()

        if (insertError) throw insertError
        memberId = inserted.id
      }

      await db.from('user_settings').upsert({ user_id: user.id })

      const { error: acceptError } = await db
        .from('family_owner_invitations')
        .update({
          status: 'accepted',
          accepted_by: user.id,
          accepted_at: new Date().toISOString(),
          email: null,
        })
        .eq('id', invitation.id)
        .eq('status', 'pending')

      if (acceptError) throw acceptError

      await db.from('activity_log').insert({
        family_id: invitation.family_id,
        actor_user_id: user.id,
        action: 'second_owner_joined',
        details: {
          member_id: memberId,
          transferred_open_items: transferredOpenItems,
        },
      })

      return json({
        status: 'accepted',
        family_id: invitation.family_id,
        member_id: memberId,
        transferred_open_items: transferredOpenItems,
      })
    }

    if (body?.action === 'bootstrap') {
      if (activeMembership) {
        return json({ status: 'exists', family_id: activeMembership.family_id })
      }

      const familyName = String(body?.family_name ?? '').trim()
      const displayName = String(body?.display_name ?? '').trim()
      const secondOwnerEmail = String(body?.second_owner_email ?? '').trim().toLowerCase()
      const managedMembers = Array.isArray(body?.managed_members)
        ? body.managed_members.map((value: unknown) => String(value).trim()).filter(Boolean)
        : []

      if (!familyName || !displayName) {
        return json({ error: 'A család neve és a saját megjelenített név kötelező.' }, 400)
      }

      if (secondOwnerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(secondOwnerEmail)) {
        return json({ error: 'A második ügygazda e-mail címe nem érvényes.' }, 400)
      }

      if (secondOwnerEmail && normalize(secondOwnerEmail) === normalize(user.email ?? '')) {
        return json({ error: 'A második ügygazda e-mail címe nem lehet a saját e-mail címed.' }, 400)
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

      let secondOwnerInvitationCreated = false
      let secondOwnerInvitationWarning: string | null = null

      if (secondOwnerEmail) {
        const { data: invitation, error: invitationError } = await db
          .from('family_owner_invitations')
          .insert({
            family_id: family.id,
            email: secondOwnerEmail,
            invited_by: user.id,
          })
          .select('id')
          .single()

        if (invitationError) throw invitationError

        try {
          const invitedUserId = await sendOwnerInvite(
            db,
            secondOwnerEmail,
            String(body?.redirect_to ?? '').trim() || null,
          )

          const { error: linkError } = await db
            .from('family_owner_invitations')
            .update({ invited_user_id: invitedUserId })
            .eq('id', invitation.id)

          if (linkError) throw linkError
          secondOwnerInvitationCreated = true
        } catch (error) {
          await db
            .from('family_owner_invitations')
            .delete()
            .eq('id', invitation.id)

          secondOwnerInvitationWarning =
            error instanceof Error ? error.message : 'A meghívót nem sikerült elküldeni.'
        }
      }

      await db.from('user_settings').upsert({ user_id: user.id })
      await db.from('activity_log').insert({
        family_id: family.id,
        actor_user_id: user.id,
        action: 'family_bootstrap_created',
        details: {
          managed_members: managedMembers,
          second_owner_invitation_created: secondOwnerInvitationCreated,
        },
      })

      return json({
        status: 'created',
        family_id: family.id,
        second_owner_invitation_created: secondOwnerInvitationCreated,
        second_owner_invitation_warning: secondOwnerInvitationWarning,
      })
    }

    if (!activeMembership) {
      return json({ error: 'Előbb hozd létre a családot.', code: 'SETUP_REQUIRED' }, 409)
    }

    const familyId = activeMembership.family_id

    if (body?.action === 'get_family_structure') {
      const [{ data: members, error: membersError }, { data: pendingInvite, error: pendingInviteError }] =
        await Promise.all([
          db
            .from('family_members')
            .select('id, display_name, member_kind, user_id')
            .eq('family_id', familyId)
            .order('created_at', { ascending: true }),
          db
            .from('family_owner_invitations')
            .select('id, status, created_at')
            .eq('family_id', familyId)
            .eq('status', 'pending')
            .maybeSingle(),
        ])

      if (membersError) throw membersError
      if (pendingInviteError) throw pendingInviteError

      const owners = (members ?? [])
        .filter((member) => member.member_kind === 'active')
        .map((member) => ({
          id: member.id,
          display_name: member.display_name,
          is_current_user: member.user_id === user.id,
        }))

      const managed = (members ?? [])
        .filter((member) => member.member_kind === 'managed')
        .map((member) => ({
          id: member.id,
          display_name: member.display_name,
        }))

      return json({
        owners,
        managed_members: managed,
        pending_second_owner_invitation: Boolean(pendingInvite),
        can_invite_second_owner: owners.length < 2 && !pendingInvite,
      })
    }

    if (body?.action === 'invite_second_owner') {
      const email = String(body?.email ?? '').trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'Adj meg egy érvényes e-mail címet.' }, 400)
      }

      if (normalize(email) === normalize(user.email ?? '')) {
        return json({ error: 'A saját e-mail címedet nem hívhatod meg második ügygazdaként.' }, 400)
      }

      const { count: ownerCount, error: ownerCountError } = await db
        .from('family_members')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', familyId)
        .eq('member_kind', 'active')

      if (ownerCountError) throw ownerCountError
      if ((ownerCount ?? 0) >= 2) {
        return json({ error: 'Ebben a családban már megvan a két ügygazda.' }, 409)
      }

      const { data: existingPending, error: pendingError } = await db
        .from('family_owner_invitations')
        .select('id')
        .eq('family_id', familyId)
        .eq('status', 'pending')
        .maybeSingle()

      if (pendingError) throw pendingError
      if (existingPending) {
        return json({ error: 'Már van kiküldött, elfogadásra váró ügygazda-meghívó.' }, 409)
      }

      const { data: invitation, error: invitationError } = await db
        .from('family_owner_invitations')
        .insert({
          family_id: familyId,
          email,
          invited_by: user.id,
        })
        .select('id')
        .single()

      if (invitationError) throw invitationError

      try {
        const invitedUserId = await sendOwnerInvite(
          db,
          email,
          String(body?.redirect_to ?? '').trim() || null,
        )

        const { error: linkError } = await db
          .from('family_owner_invitations')
          .update({ invited_user_id: invitedUserId })
          .eq('id', invitation.id)

        if (linkError) throw linkError
      } catch (error) {
        await db.from('family_owner_invitations').delete().eq('id', invitation.id)
        throw error
      }

      await db.from('activity_log').insert({
        family_id: familyId,
        actor_user_id: user.id,
        action: 'second_owner_invited',
        details: {},
      })

      return json({ status: 'invited' })
    }

    if (body?.action === 'get_settings') {
      const { data: settings, error: settingsError } = await db
        .from('user_settings')
        .select('timezone, briefing_enabled, briefing_time, notify_partner_on_complete')
        .eq('user_id', user.id)
        .maybeSingle()

      if (settingsError) throw settingsError

      return json({
        settings: settings ?? {
          timezone: 'Europe/Budapest',
          briefing_enabled: true,
          briefing_time: '07:00:00',
          notify_partner_on_complete: false,
        },
      })
    }

    if (body?.action === 'update_settings') {
      const briefingEnabled = Boolean(body?.briefing_enabled)
      const briefingTime = String(body?.briefing_time ?? '').trim()

      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(briefingTime)) {
        return json({ error: 'A briefing időpontja HH:MM formátumú legyen.' }, 400)
      }

      const { data: settings, error: settingsError } = await db
        .from('user_settings')
        .upsert({
          user_id: user.id,
          briefing_enabled: briefingEnabled,
          briefing_time: briefingTime,
          updated_at: new Date().toISOString(),
        })
        .select('timezone, briefing_enabled, briefing_time, notify_partner_on_complete')
        .single()

      if (settingsError) throw settingsError

      await db.from('activity_log').insert({
        family_id: familyId,
        actor_user_id: user.id,
        action: 'user_settings_updated',
        details: {
          briefing_enabled: settings.briefing_enabled,
          briefing_time: settings.briefing_time,
        },
      })

      return json({ status: 'updated', settings })
    }

    if (body?.action === 'query_items') {
      const message = String(body?.message ?? '').trim()
      if (!message) return json({ error: 'A kérdés nem lehet üres.' }, 400)

      const [{ data: members, error: membersError }, { data: settings }] = await Promise.all([
        db
          .from('family_members')
          .select('id, display_name, member_kind, user_id')
          .eq('family_id', familyId),
        db
          .from('user_settings')
          .select('timezone')
          .eq('user_id', user.id)
          .maybeSingle(),
      ])

      if (membersError) throw membersError

      const memberList = members ?? []
      const interpretation = await interpretQueryWithOpenAI(
        message,
        memberList
          .filter((member) => member.member_kind === 'active')
          .map((member) => member.display_name),
        memberList
          .filter((member) => member.member_kind === 'managed')
          .map((member) => member.display_name),
      )

      const timeZone = settings?.timezone ?? 'Europe/Budapest'
      const dateRange = resolveQueryDateRange(
        interpretation.date_scope,
        interpretation.date_phrase,
        timeZone,
      )

      if (interpretation.date_scope === 'specific_date' && !dateRange) {
        return json({
          status: 'needs_clarification',
          answer: 'A megadott dátumot nem tudom biztonságosan értelmezni. Írd le másképp.',
        })
      }

      let subjectId: string | null = null
      if (interpretation.subject_name) {
        const wanted = normalize(interpretation.subject_name)
        const subject = memberList.find((member) => normalize(member.display_name) === wanted) ?? null

        if (!subject) {
          return json({
            status: 'needs_clarification',
            answer: `Nem találtam ilyen családtagot: ${interpretation.subject_name}.`,
          })
        }

        subjectId = subject.id
      }

      let responsibleUserId: string | null = null
      if (interpretation.responsible_name) {
        const wanted = normalize(interpretation.responsible_name)
        const responsible = memberList.find((member) =>
          member.member_kind === 'active'
          && member.user_id
          && normalize(member.display_name) === wanted
        ) ?? null

        if (!responsible?.user_id) {
          return json({
            status: 'needs_clarification',
            answer: `Nem találtam ilyen aktív családi felhasználót: ${interpretation.responsible_name}.`,
          })
        }

        responsibleUserId = responsible.user_id
      }

      let itemsQuery = db
        .from('items')
        .select('id, title, notes, due_date, due_time, status, subject_member_id, responsible_user_id, completed_at, created_at')
        .eq('family_id', familyId)
        .neq('status', 'deleted')
        .limit(200)

      if (interpretation.status !== 'all') {
        itemsQuery = itemsQuery.eq('status', interpretation.status)
      }

      if (subjectId) {
        itemsQuery = itemsQuery.eq('subject_member_id', subjectId)
      }

      if (responsibleUserId) {
        itemsQuery = itemsQuery.eq('responsible_user_id', responsibleUserId)
      }

      const { data: rawItems, error: itemsError } = await itemsQuery
      if (itemsError) throw itemsError

      const ownershipFiltered = (rawItems ?? []).filter((item) => {
        if (responsibleUserId) return true
        if (interpretation.responsibility !== 'mine') return true

        return item.responsible_user_id === user.id
      })

      const keywordTokens = interpretation.keywords
        ? normalize(interpretation.keywords)
            .split(/\s+/)
            .filter((token) => token.length >= 2)
        : []

      const filtered = ownershipFiltered.filter((item) => {
        if (keywordTokens.length) {
          const haystack = normalize(`${item.title} ${item.notes ?? ''}`)
          if (!keywordTokens.every((token) => haystack.includes(token))) return false
        }

        if (dateRange) {
          const itemDate = queryItemDate(item, timeZone)
          if (!itemDate || itemDate < dateRange.start || itemDate > dateRange.end) return false
        }

        return true
      })

      filtered.sort((a, b) => {
        if (interpretation.status === 'done') {
          return String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? ''))
        }

        const aDate = a.due_date ?? '9999-12-31'
        const bDate = b.due_date ?? '9999-12-31'
        const dateCompare = aDate.localeCompare(bDate)
        if (dateCompare !== 0) return dateCompare

        return String(a.due_time ?? '23:59:59').localeCompare(String(b.due_time ?? '23:59:59'))
      })

      const memberNameById = new Map(memberList.map((member) => [member.id, member.display_name]))
      const responsibleNameByUserId = new Map(
        memberList
          .filter((member) => member.member_kind === 'active' && member.user_id)
          .map((member) => [member.user_id, member.display_name]),
      )
      const showResponsible = Boolean(
        subjectId
        && !responsibleUserId
        && interpretation.responsibility === 'family',
      )
      const isOwnQuery = interpretation.responsibility === 'mine' && !responsibleUserId
      const queriedOtherOwnerName = responsibleUserId && responsibleUserId !== user.id
        ? responsibleNameByUserId.get(responsibleUserId) ?? null
        : null
      const visible = filtered.slice(0, 20)

      if (!visible.length) {
        return json({
          status: 'ok',
          count: 0,
          answer: 'Nem találtam a kérdésednek megfelelő ügyet.',
          interpretation,
        })
      }

      const lines = visible.map((item) => {
        const rawSubjectName = item.subject_member_id
          ? memberNameById.get(item.subject_member_id) ?? null
          : null
        const subjectName = isOwnQuery && item.subject_member_id === activeMembership.id
          ? null
          : rawSubjectName

        return queryItemLine(
          item,
          subjectName,
          item.responsible_user_id
            ? responsibleNameByUserId.get(item.responsible_user_id) ?? null
            : null,
          timeZone,
          showResponsible,
          queriedOtherOwnerName,
        )
      })

      const more = filtered.length > visible.length
        ? `\n+ még ${filtered.length - visible.length} találat`
        : ''

      return json({
        status: 'ok',
        count: filtered.length,
        answer: `${filtered.length} ügyet találtam:\n${lines.join('\n')}${more}`,
        interpretation,
      })
    }

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
        })
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
          })
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
          })
        }

        const reminderDate = addDays(dueDate, -reminderOffsetDays)
        firstReminderAt = localDateTimeToUtcIso(reminderDate, briefingTime, timeZone)

        if (new Date(firstReminderAt).getTime() <= Date.now()) {
          return json({
            error: 'A kért emlékeztetési időpont már elmúlt. Adj meg későbbi jelzést.',
            code: 'REMINDER_IN_PAST',
          }, 400)
        }
      }

      const dateText = formatHungarianDate(dueDate)
      const timeText = dueTime ? ` ${dueTime}` : ''
      const subjectText = subject ? `${subject.display_name}: ` : ''
      let confirmationText: string

      if (interpretation.reminder_phrase) {
        confirmationText = `${subjectText}${interpretation.title} – ${dateText}${timeText}. Emlékeztetés: ${interpretation.reminder_phrase}. Rögzítsem?`
      } else if (dueDate) {
        confirmationText = `${subjectText}${interpretation.title} – ${dateText}${timeText}. Emlékeztetőt nem adtál meg, ezért csak az esedékesség napjának reggeli briefingjében szólok. Így rögzítsem?`
      } else {
        confirmationText = `${subjectText}${interpretation.title}. Dátumot és emlékeztetőt nem adtál meg, ezért automatikus értesítés nem készül. Így rögzítsem?`
      }

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
        confirmation_text: confirmationText,
      }

      const duplicate = await findExactOpenDuplicate(
        db,
        familyId,
        draft.title,
        draft.due_date,
        draft.due_time,
        draft.subject_member_id,
      )

      if (duplicate) {
        const duplicateTime = duplicate.due_time ? ` ${String(duplicate.due_time).slice(0, 5)}` : ''
        const duplicateSubject = subject?.display_name ? `${subject.display_name}: ` : ''
        return json({
          status: 'duplicate',
          existing_item_id: duplicate.id,
          message: `Ez már szerepel a nyitott ügyek között: ${duplicateSubject}${duplicate.title} – ${formatHungarianDate(duplicate.due_date)}${duplicateTime}. Ha másik személynek vagy másik időpontra gondoltál, pontosítsd a mondatot.`,
        })
      }

      return json({ status: 'needs_confirmation', draft })
    }

    if (body?.action === 'add_create_reminder') {
      const draft = body?.draft as CreateDraft | undefined
      const reminderPhrase = String(body?.reminder_phrase ?? '').trim()

      if (!draft || !draft.title || !draft.item_type || !draft.due_date) {
        return json({ error: 'Ehhez az ügyhöz előbb érvényes dátum szükséges.' }, 400)
      }

      const reminderOffsetDays = reminderDaysBefore(reminderPhrase)
      if (reminderOffsetDays === null) {
        return json({
          error: 'Írd le például így: egy nappal előtte, három nappal előtte vagy két héttel előtte.',
          code: 'REMINDER_NEEDS_CLARIFICATION',
        }, 400)
      }

      const { data: settings } = await db
        .from('user_settings')
        .select('timezone, briefing_time')
        .eq('user_id', user.id)
        .maybeSingle()

      const timeZone = settings?.timezone ?? 'Europe/Budapest'
      const briefingTime = String(settings?.briefing_time ?? '07:00:00').slice(0, 5)
      const reminderDate = addDays(draft.due_date, -reminderOffsetDays)
      const today = localDateInTimezone(timeZone)

      if (reminderDate < today) {
        return json({
          error: 'Ez az emlékeztetési időpont már elmúlt. Adj meg későbbi jelzést.',
          code: 'REMINDER_IN_PAST',
        }, 400)
      }

      const firstReminderAt = localDateTimeToUtcIso(reminderDate, briefingTime, timeZone)

      if (new Date(firstReminderAt).getTime() <= Date.now()) {
        return json({
          error: 'A kért emlékeztetési időpont már elmúlt. Adj meg későbbi jelzést.',
          code: 'REMINDER_IN_PAST',
        }, 400)
      }

      const subjectText = draft.subject_display_name ? `${draft.subject_display_name}: ` : ''
      const dateText = formatHungarianDate(draft.due_date)
      const timeText = draft.due_time ? ` ${String(draft.due_time).slice(0, 5)}` : ''

      const updatedDraft: CreateDraft = {
        ...draft,
        first_reminder_at: firstReminderAt,
        reminder_phrase: reminderPhrase,
        confirmation_text: `${subjectText}${draft.title} – ${dateText}${timeText}. Emlékeztetés: ${reminderPhrase}. Rögzítsem?`,
      }

      return json({ status: 'needs_confirmation', draft: updatedDraft })
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

      const duplicate = await findExactOpenDuplicate(
        db,
        familyId,
        draft.title,
        draft.due_date,
        draft.due_time,
        draft.subject_member_id,
      )

      if (duplicate) {
        const duplicateTime = duplicate.due_time ? ` ${String(duplicate.due_time).slice(0, 5)}` : ''
        return json({
          status: 'duplicate',
          existing_item_id: duplicate.id,
          message: `Ez az ügy már rögzítve van: ${duplicate.title} – ${formatHungarianDate(duplicate.due_date)}${duplicateTime}. Ha másik személynek vagy másik időpontra gondoltál, pontosítsd a mondatot.`,
        })
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


    if (body?.action === 'interpret_update') {
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

      const interpretation = await interpretUpdateWithOpenAI(
        message,
        (members ?? []).map((member) => member.display_name),
      )

      const timeZone = settings?.timezone ?? 'Europe/Budapest'
      const newDate = interpretation.new_date_phrase
        ? resolveDatePhrase(interpretation.new_date_phrase, timeZone)
        : null
      const targetDate = interpretation.target_date_phrase
        ? resolveDatePhrase(interpretation.target_date_phrase, timeZone)
        : null
      const newTime = validateTime(interpretation.new_time)

      if (interpretation.new_date_phrase && !newDate) {
        return json({
          error: 'Az új dátumot még nem tudom biztonságosan feloldani.',
          code: 'DATE_NEEDS_CLARIFICATION',
          date_phrase: interpretation.new_date_phrase,
        })
      }

      if (interpretation.target_date_phrase && !targetDate) {
        return json({
          error: 'A keresett régi dátumot még nem tudom biztonságosan feloldani.',
          code: 'TARGET_DATE_NEEDS_CLARIFICATION',
          date_phrase: interpretation.target_date_phrase,
        })
      }

      let subjectId: string | null = null
      if (interpretation.subject_name) {
        const wanted = normalize(interpretation.subject_name)
        const subject = (members ?? []).find((member) => normalize(member.display_name) === wanted) ?? null
        if (!subject) {
          return json({
            error: `Nem találtam ilyen családtagot: ${interpretation.subject_name}.`,
            code: 'SUBJECT_NEEDS_CLARIFICATION',
            known_members: (members ?? []).map((member) => member.display_name),
          })
        }
        subjectId = subject.id
      }

      const { data: openItems, error: itemsError } = await db
        .from('items')
        .select('id, title, due_date, due_time, subject_member_id')
        .eq('family_id', familyId)
        .eq('status', 'open')
        .order('due_date', { ascending: true, nullsFirst: false })
      if (itemsError) throw itemsError

      const targetTitle = normalize(interpretation.target_title)
      const targetTokens = targetTitle.split(/\s+/).filter((token) => token.length >= 3)

      let matches = (openItems ?? []).filter((item) => {
        if (subjectId && item.subject_member_id !== subjectId) return false
        if (targetDate && item.due_date !== targetDate) return false

        const itemTitle = normalize(item.title)
        if (itemTitle.includes(targetTitle) || targetTitle.includes(itemTitle)) return true
        return targetTokens.some((token) => itemTitle.includes(token))
      })

      const memberNameById = new Map((members ?? []).map((member) => [member.id, member.display_name]))
      const candidates: UpdateCandidate[] = matches.map((item) => ({
        id: item.id,
        title: item.title,
        due_date: item.due_date,
        due_time: item.due_time,
        subject_display_name: item.subject_member_id
          ? memberNameById.get(item.subject_member_id) ?? null
          : null,
      }))

      const changes = {
        due_date: newDate,
        due_time: newTime,
        title: interpretation.new_title?.trim() || null,
      }

      const hasChanges = Boolean(changes.due_date || changes.due_time || changes.title)

      if (candidates.length === 0) {
        return json({
          status: 'no_match',
          error: 'Nem találtam egyértelműen ilyen nyitott ügyet.',
          code: 'UPDATE_TARGET_NOT_FOUND',
        })
      }

      if (candidates.length > 1) {
        return json({
          status: 'choose_target',
          candidates: candidates.map((candidate) => ({
            ...candidate,
            label: updateCandidateLabel(candidate),
          })),
          changes,
        })
      }

      if (!hasChanges) {
        return json({
          status: 'needs_change_details',
          error: 'Megtaláltam az ügyet, de még nem derül ki, mire szeretnéd módosítani.',
          candidate: {
            ...candidates[0],
            label: updateCandidateLabel(candidates[0]),
          },
        })
      }

      const candidate = candidates[0]
      const oldDate = candidate.due_date
      const oldTime = candidate.due_time ? String(candidate.due_time).slice(0, 5) : null
      const nextDate = changes.due_date ?? oldDate
      const nextTime = changes.due_time ?? oldTime
      const nextTitle = changes.title ?? candidate.title

      const { data: pending, error: pendingError } = await db
        .from('pending_actions')
        .insert({
          family_id: familyId,
          actor_user_id: user.id,
          intent: 'update',
          target_item_id: candidate.id,
          payload: {
            before: {
              title: candidate.title,
              due_date: oldDate,
              due_time: oldTime,
            },
            changes,
          },
        })
        .select('id')
        .single()
      if (pendingError) throw pendingError

      const oldText = `${candidate.title} – ${formatHungarianDate(oldDate)}${oldTime ? ` ${oldTime}` : ''}`
      const newText = `${nextTitle} – ${formatHungarianDate(nextDate)}${nextTime ? ` ${nextTime}` : ''}`

      const draft: UpdateDraft = {
        pending_action_id: pending.id,
        target_item_id: candidate.id,
        confirmation_text: `Ezt találtam: ${oldText}. Erre módosítsam: ${newText}?`,
      }

      return json({ status: 'needs_confirmation', draft })
    }

    if (body?.action === 'prepare_update_target') {
      const targetItemId = String(body?.target_item_id ?? '')
      const changes = body?.changes ?? {}

      const { data: item } = await db
        .from('items')
        .select('id, title, due_date, due_time, family_id')
        .eq('id', targetItemId)
        .eq('family_id', familyId)
        .eq('status', 'open')
        .maybeSingle()

      if (!item) return json({ error: 'A kiválasztott ügy már nem található.' })

      const normalizedChanges = {
        due_date: changes.due_date || null,
        due_time: changes.due_time || null,
        title: changes.title || null,
      }

      if (!normalizedChanges.due_date && !normalizedChanges.due_time && !normalizedChanges.title) {
        return json({
          status: 'needs_change_details',
          error: 'Megvan az ügy. Mondd meg, mire szeretnéd módosítani.',
        })
      }

      const oldTime = item.due_time ? String(item.due_time).slice(0, 5) : null
      const nextDate = normalizedChanges.due_date ?? item.due_date
      const nextTime = normalizedChanges.due_time ?? oldTime
      const nextTitle = normalizedChanges.title ?? item.title

      const { data: pending, error: pendingError } = await db
        .from('pending_actions')
        .insert({
          family_id: familyId,
          actor_user_id: user.id,
          intent: 'update',
          target_item_id: item.id,
          payload: {
            before: {
              title: item.title,
              due_date: item.due_date,
              due_time: oldTime,
            },
            changes: normalizedChanges,
          },
        })
        .select('id')
        .single()
      if (pendingError) throw pendingError

      return json({
        status: 'needs_confirmation',
        draft: {
          pending_action_id: pending.id,
          target_item_id: item.id,
          confirmation_text:
            `Ezt találtam: ${item.title} – ${formatHungarianDate(item.due_date)}${oldTime ? ` ${oldTime}` : ''}. ` +
            `Erre módosítsam: ${nextTitle} – ${formatHungarianDate(nextDate)}${nextTime ? ` ${nextTime}` : ''}?`,
        },
      })
    }

    if (body?.action === 'confirm_update') {
      const pendingActionId = String(body?.pending_action_id ?? '')
      if (!pendingActionId) return json({ error: 'Hiányzó függőben lévő művelet.' }, 400)

      const { data: pending } = await db
        .from('pending_actions')
        .select('id, target_item_id, payload, status, expires_at')
        .eq('id', pendingActionId)
        .eq('actor_user_id', user.id)
        .eq('family_id', familyId)
        .maybeSingle()

      if (!pending || pending.status !== 'pending') {
        return json({ error: 'Ez a módosítás már nem aktív.' })
      }

      if (new Date(pending.expires_at).getTime() < Date.now()) {
        await db
          .from('pending_actions')
          .update({ status: 'expired', resolved_at: new Date().toISOString() })
          .eq('id', pending.id)
        return json({ error: 'A módosítási megerősítés lejárt. Kérlek, indítsd újra.' })
      }

      const { data: item } = await db
        .from('items')
        .select('id, title, due_date, due_time')
        .eq('id', pending.target_item_id)
        .eq('family_id', familyId)
        .eq('status', 'open')
        .maybeSingle()
      if (!item) return json({ error: 'A módosítandó ügy már nem található.' })

      const changes = pending.payload?.changes ?? {}
      const updateValues: Record<string, unknown> = {}

      if (changes.title) updateValues.title = changes.title
      if (changes.due_date) updateValues.due_date = changes.due_date
      if (changes.due_time) updateValues.due_time = changes.due_time

      if (Object.keys(updateValues).length === 0) {
        return json({ error: 'Nincs végrehajtható módosítás.' })
      }

      const { data: settings } = await db
        .from('user_settings')
        .select('timezone')
        .eq('user_id', user.id)
        .maybeSingle()
      const timeZone = settings?.timezone ?? 'Europe/Budapest'

      if (changes.due_date && item.due_date) {
        const { data: reminder } = await db
          .from('reminders')
          .select('id, first_reminder_at, next_notification_at, last_sent_at')
          .eq('item_id', item.id)
          .maybeSingle()

        if (reminder?.first_reminder_at && !reminder.last_sent_at) {
          const oldReminderDate = dateInTimezone(reminder.first_reminder_at, timeZone)
          const oldReminderTime = timeInTimezone(reminder.first_reminder_at, timeZone)
          const offset = daysBetween(oldReminderDate, item.due_date)
          const newReminderDate = addDays(changes.due_date, -offset)
          const newReminderAt = localDateTimeToUtcIso(newReminderDate, oldReminderTime, timeZone)

          await db
            .from('reminders')
            .update({
              first_reminder_at: newReminderAt,
              next_notification_at: newReminderAt,
            })
            .eq('id', reminder.id)
        }
      }

      const { data: updatedItem, error: updateError } = await db
        .from('items')
        .update(updateValues)
        .eq('id', item.id)
        .select('*')
        .single()
      if (updateError) throw updateError

      await db
        .from('pending_actions')
        .update({
          status: 'confirmed',
          resolved_at: new Date().toISOString(),
        })
        .eq('id', pending.id)

      await db.from('activity_log').insert({
        family_id: familyId,
        actor_user_id: user.id,
        item_id: item.id,
        action: 'item_updated',
        details: {
          before: pending.payload?.before ?? null,
          changes,
        },
      })

      return json({ status: 'updated', item: updatedItem })
    }

    if (body?.action === 'cancel_pending') {
      const pendingActionId = String(body?.pending_action_id ?? '')
      if (!pendingActionId) return json({ status: 'cancelled' })

      await db
        .from('pending_actions')
        .update({
          status: 'cancelled',
          resolved_at: new Date().toISOString(),
        })
        .eq('id', pendingActionId)
        .eq('actor_user_id', user.id)
        .eq('family_id', familyId)
        .eq('status', 'pending')

      return json({ status: 'cancelled' })
    }


    if (body?.action === 'interpret_complete') {
      const message = String(body?.message ?? '').trim()
      if (!message) return json({ error: 'Az üzenet nem lehet üres.' }, 400)

      const [{ data: members, error: membersError }, { data: settings }] = await Promise.all([
        db
          .from('family_members')
          .select('id, display_name, member_kind, user_id')
          .eq('family_id', familyId),
        db
          .from('user_settings')
          .select('timezone')
          .eq('user_id', user.id)
          .maybeSingle(),
      ])
      if (membersError) throw membersError

      const interpretation = await interpretCompleteWithOpenAI(
        message,
        (members ?? []).map((member) => member.display_name),
      )

      const timeZone = settings?.timezone ?? 'Europe/Budapest'
      const targetDate = interpretation.target_date_phrase
        ? resolveDatePhrase(interpretation.target_date_phrase, timeZone)
        : null

      if (interpretation.target_date_phrase && !targetDate) {
        return json({
          error: 'A keresett dátumot még nem tudom biztonságosan feloldani.',
          code: 'TARGET_DATE_NEEDS_CLARIFICATION',
        })
      }

      let subjectId: string | null = null
      if (interpretation.subject_name) {
        const wanted = normalize(interpretation.subject_name)
        const subject = (members ?? []).find((member) => normalize(member.display_name) === wanted) ?? null

        if (!subject) {
          return json({
            error: `Nem találtam ilyen családtagot: ${interpretation.subject_name}.`,
            code: 'SUBJECT_NEEDS_CLARIFICATION',
          })
        }

        subjectId = subject.id
      }

      const { data: openItems, error: itemsError } = await db
        .from('items')
        .select('id, title, due_date, due_time, subject_member_id')
        .eq('family_id', familyId)
        .eq('status', 'open')
        .order('due_date', { ascending: true, nullsFirst: false })
      if (itemsError) throw itemsError

      const targetTitle = normalize(interpretation.target_title)
      const targetTokens = targetTitle.split(/\s+/).filter((token) => token.length >= 3)

      const matches = (openItems ?? []).filter((item) => {
        if (subjectId && item.subject_member_id !== subjectId) return false
        if (targetDate && item.due_date !== targetDate) return false

        const itemTitle = normalize(item.title)
        if (itemTitle.includes(targetTitle) || targetTitle.includes(itemTitle)) return true
        return targetTokens.some((token) => itemTitle.includes(token))
      })

      const memberNameById = new Map((members ?? []).map((member) => [member.id, member.display_name]))
      const candidates: UpdateCandidate[] = matches.map((item) => ({
        id: item.id,
        title: item.title,
        due_date: item.due_date,
        due_time: item.due_time,
        subject_display_name: item.subject_member_id
          ? memberNameById.get(item.subject_member_id) ?? null
          : null,
      }))

      if (candidates.length === 0) {
        return json({
          status: 'no_match',
          error: 'Nem találtam egyértelműen ilyen nyitott ügyet.',
          code: 'COMPLETE_TARGET_NOT_FOUND',
        })
      }

      if (candidates.length > 1) {
        return json({
          status: 'choose_target',
          candidates: candidates.map((candidate) => ({
            ...candidate,
            label: updateCandidateLabel(candidate),
          })),
        })
      }

      const candidate = candidates[0]

      const { data: pending, error: pendingError } = await db
        .from('pending_actions')
        .insert({
          family_id: familyId,
          actor_user_id: user.id,
          intent: 'complete',
          target_item_id: candidate.id,
          payload: {
            before: {
              title: candidate.title,
              due_date: candidate.due_date,
              due_time: candidate.due_time ? String(candidate.due_time).slice(0, 5) : null,
            },
          },
        })
        .select('id')
        .single()
      if (pendingError) throw pendingError

      const draft: CompleteDraft = {
        pending_action_id: pending.id,
        target_item_id: candidate.id,
        confirmation_text: `Ezt találtam: ${updateCandidateLabel(candidate)}. Jelöljem késznek?`,
      }

      return json({ status: 'needs_confirmation', draft })
    }

    if (body?.action === 'prepare_complete_target') {
      const targetItemId = String(body?.target_item_id ?? '')

      const { data: item } = await db
        .from('items')
        .select('id, title, due_date, due_time, subject_member_id')
        .eq('id', targetItemId)
        .eq('family_id', familyId)
        .eq('status', 'open')
        .maybeSingle()

      if (!item) return json({ error: 'A kiválasztott ügy már nem található.' })

      const { data: subject } = item.subject_member_id
        ? await db
            .from('family_members')
            .select('display_name')
            .eq('id', item.subject_member_id)
            .eq('family_id', familyId)
            .maybeSingle()
        : { data: null }

      const candidate: UpdateCandidate = {
        id: item.id,
        title: item.title,
        due_date: item.due_date,
        due_time: item.due_time,
        subject_display_name: subject?.display_name ?? null,
      }

      const { data: pending, error: pendingError } = await db
        .from('pending_actions')
        .insert({
          family_id: familyId,
          actor_user_id: user.id,
          intent: 'complete',
          target_item_id: item.id,
          payload: {
            before: {
              title: item.title,
              due_date: item.due_date,
              due_time: item.due_time ? String(item.due_time).slice(0, 5) : null,
            },
          },
        })
        .select('id')
        .single()
      if (pendingError) throw pendingError

      return json({
        status: 'needs_confirmation',
        draft: {
          pending_action_id: pending.id,
          target_item_id: item.id,
          confirmation_text: `Ezt találtam: ${updateCandidateLabel(candidate)}. Jelöljem késznek?`,
        },
      })
    }

    if (body?.action === 'confirm_complete') {
      const pendingActionId = String(body?.pending_action_id ?? '')
      if (!pendingActionId) return json({ error: 'Hiányzó függőben lévő művelet.' }, 400)

      const { data: pending } = await db
        .from('pending_actions')
        .select('id, target_item_id, payload, status, expires_at')
        .eq('id', pendingActionId)
        .eq('actor_user_id', user.id)
        .eq('family_id', familyId)
        .eq('intent', 'complete')
        .maybeSingle()

      if (!pending || pending.status !== 'pending') {
        return json({ error: 'Ez a lezárás már nem aktív.' })
      }

      if (new Date(pending.expires_at).getTime() < Date.now()) {
        await db
          .from('pending_actions')
          .update({ status: 'expired', resolved_at: new Date().toISOString() })
          .eq('id', pending.id)

        return json({ error: 'A lezárási megerősítés lejárt. Kérlek, indítsd újra.' })
      }

      const completedAt = new Date().toISOString()

      const { data: updatedItem, error: updateError } = await db
        .from('items')
        .update({
          status: 'done',
          completed_at: completedAt,
        })
        .eq('id', pending.target_item_id)
        .eq('family_id', familyId)
        .eq('status', 'open')
        .select('*')
        .single()
      if (updateError) throw updateError

      await db
        .from('reminders')
        .update({
          enabled: false,
          next_notification_at: null,
        })
        .eq('item_id', updatedItem.id)

      await db
        .from('pending_actions')
        .update({
          status: 'confirmed',
          resolved_at: completedAt,
        })
        .eq('id', pending.id)

      await db.from('activity_log').insert({
        family_id: familyId,
        actor_user_id: user.id,
        item_id: updatedItem.id,
        action: 'item_completed',
        details: {
          before: pending.payload?.before ?? null,
          completed_at: completedAt,
        },
      })

      return json({ status: 'completed', item: updatedItem })
    }

    return json({ error: 'Ismeretlen művelet.' }, 400)
  } catch (error) {
    console.error(error)
    return json({
      error: error instanceof Error ? error.message : 'Ismeretlen szerverhiba.',
    }, 500)
  }
})
