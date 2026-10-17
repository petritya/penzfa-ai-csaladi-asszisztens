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

function localTimeInTimezone(timeZone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.hour}:${values.minute}`
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

async function sendOneSignalPush(
  userId: string,
  title: string,
  message: string,
  launchUrl?: string,
) {
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
      priority: 10, // Android / Chrome: high priority (Doze módban is sürgős)
      headings: { en: title },
      contents: { en: message },
      ...(launchUrl ? { url: launchUrl } : {}),
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

// Az ügy pontos időpontjához és felelőséhez tartozó deduplikációs kulcs.
// A DB-trigger dátum-, idő- vagy felelősváltozáskor kiüríti ezt a jelzőt.
function duePushKey(item: {
  due_date: string | null
  due_time: string | null
  responsible_user_id: string | null
}) {
  if (!item.due_date || !item.due_time || !item.responsible_user_id) return null
  return `${item.due_date}|${String(item.due_time).slice(0, 5)}|${item.responsible_user_id}`
}

async function claimDuePush(item: {
  id: string
  due_date: string | null
  due_time: string | null
  responsible_user_id: string | null
}, key: string) {
  const { data, error } = await db
    .from('items')
    .update({ due_push_sent_key: key })
    .eq('id', item.id)
    .eq('status', 'open')
    .eq('due_date', item.due_date)
    .eq('due_time', item.due_time)
    .eq('responsible_user_id', item.responsible_user_id)
    .neq('due_push_sent_key', key)
    .select('id')
    .maybeSingle()

  if (error) throw error
  return Boolean(data)
}

async function releaseDuePush(itemId: string, key: string) {
  // Ha közben átírták az ügyet, az újabb állapotot nem írjuk felül.
  const { error } = await db
    .from('items')
    .update({ due_push_sent_key: '' })
    .eq('id', itemId)
    .eq('due_push_sent_key', key)
  if (error) throw error
}

async function sendDueItemPushes(nowIso: string) {
  // UTC ±1 nap elég minden valós időzónához; a pontos percet
  // minden felelős saját időzónájában határozzuk meg.
  const utcDate = nowIso.slice(0, 10)
  const { data: items, error } = await db
    .from('items')
    .select('id, family_id, title, due_date, due_time, responsible_user_id, subject_member_id')
    .eq('status', 'open')
    .not('responsible_user_id', 'is', null)
    .not('due_time', 'is', null)
    .gte('due_date', addDays(utcDate, -1))
    .lte('due_date', addDays(utcDate, 1))
    .order('due_date')
    .order('due_time')
    .limit(500)

  if (error) throw error
  if (!items?.length) return { processed: 0, sent: 0, results: [] as unknown[] }

  const userIds = [...new Set(items.map((item) => item.responsible_user_id as string))]
  const { data: userSettings, error: settingsError } = await db
    .from('user_settings')
    .select('user_id, timezone')
    .in('user_id', userIds)
  if (settingsError) throw settingsError

  const timezones = new Map((userSettings ?? []).map((setting) => [setting.user_id, setting.timezone]))
  const now = Date.parse(nowIso)
  let sent = 0
  let processed = 0
  const results: unknown[] = []

  for (const item of items) {
    const key = duePushKey(item)
    if (!key) continue
    const zone = timezones.get(item.responsible_user_id) ?? 'Europe/Budapest'
    const dueAt = Date.parse(
      localDateTimeToUtcIso(item.due_date, String(item.due_time).slice(0, 5), zone),
    )
    // Nem küldünk előre, és a régi lejárt ügyek sem kapnak hirtelen push-t.
    // Néhány perces ütemező-késést viszont elviselünk.
    if (now < dueAt || now - dueAt > 3 * 60 * 1000) continue

    const claimed = await claimDuePush(item, key)
    if (!claimed) continue
    processed += 1

    const { data: subject } = item.subject_member_id
      ? await db.from('family_members')
          .select('display_name')
          .eq('id', item.subject_member_id)
          .maybeSingle()
      : { data: null }

    const subjectPrefix = subject?.display_name ? `${subject.display_name}: ` : ''
    const message = `${subjectPrefix}${item.title} – ${formatDate(item.due_date)} ${String(item.due_time).slice(0, 5)}.`
    const appUrl = Deno.env.get('APP_URL')
      ?? 'https://penzfa-ai-csaladi-asszisztens.petritya.workers.dev'
    const launchUrl = `${appUrl}/?push=item&item_id=${encodeURIComponent(item.id)}`

    let delivery: Awaited<ReturnType<typeof sendOneSignalPush>>
    try {
      delivery = await sendOneSignalPush(
        item.responsible_user_id,
        'Pénzfa – esedékes ügy',
        message,
        launchUrl,
      )
    } catch (error) {
      // Csak a bizonyosan sikertelen küldést próbáljuk újra.
      await releaseDuePush(item.id, key)
      results.push({
        item_id: item.id,
        sent: false,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (!delivery.sent) {
      await releaseDuePush(item.id, key)
      results.push({ item_id: item.id, sent: false, error: delivery.error })
      continue
    }

    sent += 1
    const { error: logError } = await db.from('activity_log').insert({
      family_id: item.family_id,
      actor_user_id: null,
      item_id: item.id,
      action: 'item_due_push_sent',
      details: {
        due_push_key: key,
        due_push_user_id: item.responsible_user_id,
        notification_id: delivery.notification_id ?? null,
      },
    })
    if (logError) console.error('Eseménykori push naplózási hiba:', logError)
    results.push({ item_id: item.id, sent: true })
  }
  return { processed, sent, results }
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
    // A pontos eseményidőpontú push a személyes emlékeztetők nélkül is működik.
    // Előbb az esemény-pusht dolgozzuk fel, hogy az ugyanarra a percre
    // beállított emlékeztető ne küldjön duplán.
    const duePush = await sendDueItemPushes(nowIso)

    const { data: dueReminders, error: dueError } = await db
      .from('reminders')
      .select('id, item_id, user_id, next_notification_at, follow_up_step')
      .eq('enabled', true)
      .not('next_notification_at', 'is', null)
      .lte('next_notification_at', nowIso)
      .order('next_notification_at', { ascending: true })
      .limit(100)

    if (dueError) throw dueError
    if (!dueReminders?.length) {
      return json({
        status: 'ok',
        processed: 0,
        sent: 0,
        due_push_processed: duePush.processed,
        due_push_sent: duePush.sent,
        due_push_results: duePush.results,
      })
    }

    let sent = 0
    const results: unknown[] = []

    for (const reminder of dueReminders) {
      const originalNextNotificationAt = reminder.next_notification_at

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

      if (item.status !== 'open' || !reminder.user_id) {
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
          .select('timezone, briefing_time, briefing_enabled')
          .eq('user_id', reminder.user_id)
          .maybeSingle(),
      ])

      const timeZone = settings?.timezone ?? 'Europe/Budapest'
      const briefingTime = String(settings?.briefing_time ?? '07:00:00').slice(0, 5)
      const reminderLocalTime = originalNextNotificationAt
        ? localTimeInTimezone(timeZone, new Date(originalNextNotificationAt))
        : null

      if (
        settings?.briefing_enabled
        && reminderLocalTime === briefingTime
        && reminder.user_id === item.responsible_user_id
      ) {
        continue
      }

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

      // Az ügy kezdetének percére eső személyes emlékeztető és az
      // eseménykori push ugyanannak a felelősnek csak egyszer jelezzen.
      const eventKey = duePushKey(item)
      const eventAt = eventKey
        ? localDateTimeToUtcIso(
            item.due_date,
            String(item.due_time).slice(0, 5),
            timeZone,
          )
        : null
      const overlapsEvent = Boolean(
        eventKey
        && eventAt
        && item.responsible_user_id === reminder.user_id
        && originalNextNotificationAt
        && Math.floor(Date.parse(originalNextNotificationAt) / 60000)
          === Math.floor(Date.parse(eventAt) / 60000)
      )

      let claimedEventKey = false
      if (overlapsEvent && eventKey) {
        claimedEventKey = await claimDuePush(item, eventKey)
        if (!claimedEventKey) {
          // Már elindult/megérkezett az esedékességi push.
          await db.from('reminders').update({
            enabled: false,
            next_notification_at: null,
          }).eq('id', reminder.id)
          results.push({ reminder_id: reminder.id, sent: false, duplicate_due_push: true })
          continue
        }
      }

      const subjectPrefix = subject?.display_name ? `${subject.display_name}: ` : ''
      const dateText = formatDate(item.due_date)
      const timeText = item.due_time ? ` ${String(item.due_time).slice(0, 5)}` : ''
      const message = dateText
        ? `${subjectPrefix}${item.title} – ${dateText}${timeText}.`
        : `${subjectPrefix}${item.title}.`

      const appUrl = Deno.env.get('APP_URL')
        ?? 'https://penzfa-ai-csaladi-asszisztens.petritya.workers.dev'
      const launchUrl = `${appUrl}/?push=reminder&item_id=${encodeURIComponent(item.id)}`

      const delivery = await sendOneSignalPush(
        reminder.user_id,
        'Pénzfa emlékeztető',
        message,
        launchUrl,
      )

      if (!delivery.sent) {
        if (claimedEventKey && eventKey) await releaseDuePush(item.id, eventKey)
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

      let nextNotificationAt: string | null = null

      if (item.due_date) {
        const sentLocalDate = localDateInTimezone(timeZone, new Date(nowIso))
        const daysRemaining = daysBetween(sentLocalDate, item.due_date)

        if (daysRemaining > 0) {
          const nextDaysBefore = daysRemaining <= 1 ? 0 : Math.ceil(daysRemaining / 2)
          const nextDate = addDays(item.due_date, -nextDaysBefore)
          const nextTime = item.due_time
            ? String(item.due_time).slice(0, 5)
            : briefingTime
          nextNotificationAt = localDateTimeToUtcIso(nextDate, nextTime, timeZone)
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
          reminder_user_id: reminder.user_id,
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
      due_push_processed: duePush.processed,
      due_push_sent: duePush.sent,
      due_push_results: duePush.results,
    })
  } catch (error) {
    console.error(error)
    return json({
      error: error instanceof Error ? error.message : 'Ismeretlen scheduler hiba.',
    }, 500)
  }
})
