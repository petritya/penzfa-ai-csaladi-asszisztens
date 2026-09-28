# Pénzfa – AI családi asszisztens MVP

A repository a 7 Core funkcióhoz szükséges minimális technikai alapot tartalmazza.

## Rögzített MVP stack

- Frontend: React + TypeScript + Vite PWA
- Frontend hosting: Cloudflare Pages / statikus hosting
- Adatbázis: Supabase PostgreSQL
- Auth: Supabase Auth
- Jogosultság: PostgreSQL RLS
- Core API: Supabase Edge Functions + SQL
- AI: cserélhető LLM adapter, strukturált kimenettel; közvetlen DB-írás nélkül
- Időzítés: Supabase Cron + `next_notification_at`
- Push: OneSignal adapter mögött
- Hang: a telefon saját diktálása

## Tudatosan nincs benne

- külön Node/Express backend
- ORM
- Redis / queue / message broker
- microservice-ek
- multi-agent rendszer
- saját speech-to-text
- natív mobilapp
- dokumentumtárolás, bank, EESZT, webshop vagy más későbbi modul

## Adatmodell – első migráció

A `supabase/migrations/20260928150000_core_schema.sql` létrehozza:

- `families`
- `family_members`
- `user_settings`
- `items`
- `reminders`
- `pending_actions`
- `activity_log`

A közvetlen kliensírás tudatosan korlátozott: a Core üzleti módosításai később Edge Functionön keresztül mennek.

## Indítás helyben

1. Másold a `.env.example` fájlt `.env.local` néven.
2. Töltsd ki a Supabase URL-t és publishable key-t.
3. `npm install`
4. `npm run dev`

A Supabase projekt összekötése után a migráció alkalmazható.
