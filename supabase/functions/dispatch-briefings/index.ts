import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function localParts(timeZone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  }
}

function formatShortDate(dateIso: string | null) {
  if (!dateIso) return ''
  const [year, month, day] = dateIso.split('-').map(Number)
  return new Intl.DateTimeFormat('hu-HU', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

function addDays(dateIso: string, days: number) {
  const [year, month, day] = dateIso.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function daysBetween(fromDateIso: string, toDateIso: string) {
  const [fy, fm, fd] = fromDateIso.split('-').map(Number)
  const [ty, tm, td] = toDateIso.split('-').map(Number)
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000,
  )
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

async function sendOneSignalPush(userId: string, title: string, message: string) {
  const appId = Deno.env.get('ONESIGNAL_APP_ID')
  const restApiKey = Deno.env.get('ONESIGNAL_REST_API_KEY')

  if (!appId || !restApiKey) {
    return { sent: false, error: 'OneSignal nincs beállítva.' }
  }

  const response = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: {
      Authorization: `Key ${restApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      app_id: appId,
      include_aliases: { external_id: [userId] },
      target_channel: 'push',
      headings: { en: title },
      contents: { en: message },
    }),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || !data?.id) {
    return {
      sent: false,
      error: data?.errors ?? data?.error ?? `OneSignal HTTP ${response.status}`,
    }
  }

  return { sent: true, notification_id: data.id }
}

function itemLine(
  title: string,
  subjectName: string | null,
  dueDate: string | null,
  dueTime: string | null,
  prefix = '',
) {
  const subject = subjectName ? `${subjectName}: ` : ''
  const date = dueDate ? formatShortDate(dueDate) : ''
  const time = dueTime ? ` ${String(dueTime).slice(0, 5)}` : ''
  const when = [date, time.trim()].filter(Boolean).join(' ')

  return `${prefix}${subject}${title}${when ? ` – ${when}` : ''}`
}

function buildBriefingMessage(
  displayName: string,
  dueToday: any[],
  overdue: any[],
  reminderToday: any[],
) {
  const lines: string[] = [`Jó reggelt, ${displayName}!`]

  if (!dueToday.length && !overdue.length && !reminderToday.length) {
    lines.push('Mára nincs esedékes vagy jelzendő nyitott ügy.')
    return lines.join('\n')
  }

  for (const item of dueToday.slice(0, 4)) {
    lines.push(itemLine(item.title, item.subject_name, item.due_date, item.due_time, 'Ma: '))
  }

  for (const item of overdue.slice(0, 3)) {
    lines.push(itemLine(item.title, item.subject_name, item.due_date, item.due_time, 'Lejárt: '))
  }

  for (const item of reminderToday.slice(0, 3)) {
    lines.push(itemLine(item.title, item.subject_name, item.due_date, item.due_time, 'Emlékeztető: '))
  }

  const shown = Math.min(dueToday.length, 4)
    + Math.min(overdue.length, 3)
    + Math.min(reminderToday.length, 3)
  const total = dueToday.length + overdue.length + reminderToday.length

  if (total > shown) lines.push(`+ még ${total - shown} ügy`)

  return lines.join('\n')
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Csak POST kérés támogatott.' }, 405)

  try {
    const now = new Date()

    const { data: settingsRows, error: settingsError } = await db
      .from('user_settings')
      .select('user_id, timezone, briefing_enabled, briefing_time')
      .eq('briefing_enabled', true)

    if (settingsError) throw settingsError

    let sent = 0
    const results: unknown[] = []

    for (const settings of settingsRows ?? []) {
      const timeZone = settings.timezone ?? 'Europe/Budapest'
      const briefingTime = String(settings.briefing_time ?? '07:00:00').slice(0, 5)
      const local = localParts(timeZone, now)

      if (local.time !== briefingTime) continue

      const { data: membership } = await db
        .from('family_members')
        .select('family_id, display_name')
        .eq('user_id', settings.user_id)
        .eq('member_kind', 'active')
        .maybeSingle()

      if (!membership) continue

      const { data: existingRun } = await db
        .from('briefing_runs')
        .select('id, status')
        .eq('user_id', settings.user_id)
        .eq('briefing_date', local.date)
        .maybeSingle()

      if (existingRun?.status === 'sent' || existingRun?.status === 'pending') continue

      const { data: rawItems, error: itemsError } = await db
        .from('items')
        .select('id, title, due_date, due_time, subject_member_id, responsible_user_id')
        .eq('family_id', membership.family_id)
        .eq('responsible_user_id', settings.user_id)
        .eq('status', 'open')
        .order('due_date', { ascending: true, nullsFirst: false })

      if (itemsError) throw itemsError

      const itemIds = (rawItems ?? []).map((item) => item.id)

      const [{ data: members }, { data: reminders }] = await Promise.all([
        db
          .from('family_members')
          .select('id, display_name')
          .eq('family_id', membership.family_id),
        itemIds.length
          ? db
              .from('reminders')
              .select('id, item_id, first_reminder_at, next_notification_at, follow_up_step, last_sent_at, enabled')
              .in('item_id', itemIds)
          : Promise.resolve({ data: [] }),
      ])

      const memberNames = new Map((members ?? []).map((member) => [member.id, member.display_name]))
      const reminderByItem = new Map((reminders ?? []).map((reminder) => [reminder.item_id, reminder]))

      const items = (rawItems ?? []).map((item) => ({
        ...item,
        subject_name: item.subject_member_id
          ? memberNames.get(item.subject_member_id) ?? null
          : null,
      }))

      const overdue = items.filter((item) => item.due_date && item.due_date < local.date)
      const dueToday = items.filter((item) => item.due_date === local.date)

      const reminderToday = items.filter((item) => {
        if (!item.due_date || item.due_date <= local.date) return false
        const reminder = reminderByItem.get(item.id)
        if (!reminder?.enabled || !reminder.next_notification_at) return false

        const reminderLocal = localParts(timeZone, new Date(reminder.next_notification_at))
        return reminderLocal.date === local.date && reminderLocal.time <= briefingTime
      })

      const message = buildBriefingMessage(
        membership.display_name,
        dueToday,
        overdue,
        reminderToday,
      )

      const { data: run, error: runError } = await db
        .from('briefing_runs')
        .upsert(
          {
            user_id: settings.user_id,
            family_id: membership.family_id,
            briefing_date: local.date,
            message,
            status: 'pending',
            sent_at: null,
          },
          { onConflict: 'user_id,briefing_date' },
        )
        .select('id')
        .single()

      if (runError) throw runError

      const delivery = await sendOneSignalPush(
        settings.user_id,
        'Pénzfa – reggeli briefing',
        message,
      )

      if (!delivery.sent) {
        await db
          .from('briefing_runs')
          .update({ status: 'failed' })
          .eq('id', run.id)

        results.push({ user_id: settings.user_id, sent: false, error: delivery.error })
        continue
      }

      for (const item of reminderToday) {
        const reminder = reminderByItem.get(item.id)
        if (!reminder?.next_notification_at || !item.due_date) continue

        const daysRemaining = daysBetween(local.date, item.due_date)
        let nextNotificationAt: string | null = null

        if (daysRemaining > 0) {
          const nextDaysBefore = daysRemaining <= 1 ? 0 : Math.ceil(daysRemaining / 2)
          const nextDate = addDays(item.due_date, -nextDaysBefore)
          const nextTime = item.due_time
            ? String(item.due_time).slice(0, 5)
            : briefingTime
          nextNotificationAt = localDateTimeToUtcIso(nextDate, nextTime, timeZone)
        }

        await db
          .from('reminders')
          .update({
            last_sent_at: now.toISOString(),
            next_notification_at: nextNotificationAt,
            follow_up_step: Number(reminder.follow_up_step ?? 0) + 1,
            enabled: Boolean(nextNotificationAt),
          })
          .eq('id', reminder.id)
      }

      await db
        .from('briefing_runs')
        .update({
          status: 'sent',
          sent_at: now.toISOString(),
        })
        .eq('id', run.id)

      await db.from('activity_log').insert({
        family_id: membership.family_id,
        actor_user_id: settings.user_id,
        action: 'morning_briefing_sent',
        details: {
          briefing_date: local.date,
          notification_id: delivery.notification_id ?? null,
          overdue_count: overdue.length,
          due_today_count: dueToday.length,
          reminder_today_count: reminderToday.length,
        },
      })

      sent += 1
      results.push({ user_id: settings.user_id, sent: true })
    }

    return json({
      status: 'ok',
      checked: settingsRows?.length ?? 0,
      sent,
      results,
    })
  } catch (error) {
    console.error(error)
    return json({
      error: error instanceof Error ? error.message : 'Ismeretlen briefing hiba.',
    }, 500)
  }
})
