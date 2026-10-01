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

function formatDate(dateIso: string | null) {
  if (!dateIso) return null
  const [year, month, day] = dateIso.split('-').map(Number)
  return new Intl.DateTimeFormat('hu-HU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

function localDateInTimezone(timeZone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
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
    return { configured: false, sent: false, error: 'OneSignal nincs még beállítva.' }
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

  if (!response.ok) {
    return {
      configured: true,
      sent: false,
      error: data?.errors ?? data?.error ?? `OneSignal HTTP ${response.status}`,
    }
  }

  if (!data?.id) {
    return {
      configured: true,
      sent: false,
      error: data?.errors ?? 'Nincs feliratkozott push-címzett ehhez a felhasználóhoz.',
    }
  }

  return { configured: true, sent: true, notification_id: data.id }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Csak POST kérés támogatott.' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const appId = Deno.env.get('ONESIGNAL_APP_ID')
    const restApiKey = Deno.env.get('ONESIGNAL_REST_API_KEY')

    if (!appId || !restApiKey) {
      return json({
        status: 'waiting_for_push_setup',
        message: 'A scheduler él, de a OneSignal még nincs beállítva.',
      })
    }

    if (body?.action === 'notification_status') {
      const notificationId = String(body?.notification_id ?? '')
      if (!notificationId) return json({ error: 'Hiányzó notification_id.' }, 400)

      const response = await fetch(
        `https://api.onesignal.com/notifications/${notificationId}?app_id=${appId}`,
        {
          headers: {
            Authorization: `Key ${restApiKey}`,
            Accept: 'application/json',
          },
        },
      )

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        return json({
          error: data?.errors ?? data?.error ?? `OneSignal HTTP ${response.status}`,
        }, response.status)
      }

      return json({
        id: data?.id ?? notificationId,
        successful: data?.successful ?? null,
        failed: data?.failed ?? null,
        errored: data?.errored ?? null,
        remaining: data?.remaining ?? null,
        received: data?.received ?? null,
        completed_at: data?.completed_at ?? null,
        platform_delivery_stats: data?.platform_delivery_stats ?? null,
      })
    }

    const nowIso = new Date().toISOString()

    const { data: dueReminders, error: dueError } = await db
      .from('reminders')
      .select('id, item_id, next_notification_at, follow_up_step')
      .eq('enabled', true)
      .not('next_notification_at', 'is', null)
      .lte('next_notification_at', nowIso)
      .order('next_notification_at', { ascending: true })
      .limit(100)

    if (dueError) throw dueError
    if (!dueReminders?.length) return json({ status: 'ok', processed: 0, sent: 0 })

    let sent = 0
    const results: unknown[] = []

    for (const reminder of dueReminders) {
      const originalNextNotificationAt = reminder.next_notification_at

      const { data: claimed } = await db
        .from('reminders')
        .update({
          next_notification_at: null,
          last_sent_at: nowIso,
        })
        .eq('id', reminder.id)
        .eq('enabled', true)
        .lte('next_notification_at', nowIso)
        .select('id')
        .maybeSingle()

      if (!claimed) continue

      const { data: item, error: itemError } = await db
        .from('items')
        .select('id, family_id, title, due_date, due_time, status, responsible_user_id, subject_member_id')
        .eq('id', reminder.item_id)
        .maybeSingle()

      if (itemError || !item) {
        await db
          .from('reminders')
          .update({ enabled: false, next_notification_at: null })
          .eq('id', reminder.id)
        continue
      }

      if (item.status !== 'open' || !item.responsible_user_id) {
        await db
          .from('reminders')
          .update({ enabled: false, next_notification_at: null })
          .eq('id', reminder.id)
        continue
      }

      const [{ data: subject }, { data: settings }] = await Promise.all([
        item.subject_member_id
          ? db
              .from('family_members')
              .select('display_name')
              .eq('id', item.subject_member_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        db
          .from('user_settings')
          .select('timezone, briefing_time')
          .eq('user_id', item.responsible_user_id)
          .maybeSingle(),
      ])

      const subjectPrefix = subject?.display_name ? `${subject.display_name}: ` : ''
      const dateText = formatDate(item.due_date)
      const timeText = item.due_time ? ` ${String(item.due_time).slice(0, 5)}` : ''
      const message = dateText
        ? `${subjectPrefix}${item.title} – ${dateText}${timeText}.`
        : `${subjectPrefix}${item.title}.`

      const delivery = await sendOneSignalPush(
        item.responsible_user_id,
        'Pénzfa emlékeztető',
        message,
      )

      if (!delivery.sent) {
        await db
          .from('reminders')
          .update({
            next_notification_at: originalNextNotificationAt,
            last_sent_at: null,
          })
          .eq('id', reminder.id)

        results.push({ reminder_id: reminder.id, sent: false, error: delivery.error })
        continue
      }

      sent += 1

      const timeZone = settings?.timezone ?? 'Europe/Budapest'
      const briefingTime = String(settings?.briefing_time ?? '07:00:00').slice(0, 5)
      let nextNotificationAt: string | null = null

      if (item.due_date) {
        const sentLocalDate = localDateInTimezone(timeZone, new Date(nowIso))
        const daysRemaining = daysBetween(sentLocalDate, item.due_date)

        if (daysRemaining > 0) {
          const nextDaysBefore = daysRemaining <= 1 ? 0 : Math.ceil(daysRemaining / 2)
          const nextDate = addDays(item.due_date, -nextDaysBefore)
          nextNotificationAt = localDateTimeToUtcIso(nextDate, briefingTime, timeZone)
        }
      }

      await db
        .from('reminders')
        .update({
          next_notification_at: nextNotificationAt,
          follow_up_step: Number(reminder.follow_up_step ?? 0) + 1,
          last_sent_at: nowIso,
          enabled: Boolean(nextNotificationAt),
        })
        .eq('id', reminder.id)

      await db.from('activity_log').insert({
        family_id: item.family_id,
        actor_user_id: null,
        item_id: item.id,
        action: 'reminder_sent',
        details: {
          reminder_id: reminder.id,
          notification_id: delivery.notification_id ?? null,
          next_notification_at: nextNotificationAt,
        },
      })

      results.push({
        reminder_id: reminder.id,
        sent: true,
        next_notification_at: nextNotificationAt,
      })
    }

    return json({
      status: 'ok',
      processed: dueReminders.length,
      sent,
      results,
    })
  } catch (error) {
    console.error(error)
    return json({
      error: error instanceof Error ? error.message : 'Ismeretlen scheduler hiba.',
    }, 500)
  }
})
