export type AppLocale = 'hu-HU' | 'da-DK'

const APP_LOCALE_STORAGE_KEY = 'ai-family-assistant-locale'

const messages = {
  'hu-HU': {
    language: 'Nyelv',
    detectedLanguage: 'Telefon / böngésző nyelve',
    timezone: 'Időzóna',
    timezoneMatches: 'egyezik a telefonnal',
    detectedTimezone: 'Telefon időzónája',
    savedTimezone: 'Értesítések időzónája',
    applyTimezone: 'Telefon időzónájának használata',
    timezoneSaved: 'Az értesítések időzónája frissítve.',
    localeSaved: 'Nyelvi beállítás mentve.',
    localeError: 'A nyelvi beállítást nem sikerült menteni.',
    timezoneError: 'Az időzóna nem módosítható.',
    settings: 'Beállítások',
    appearance: 'Megjelenés',
    systemAppearance: 'Rendszer beállítása',
    lightAppearance: 'Világos',
    darkAppearance: 'Sötét',
    morningBriefing: 'Reggeli briefing',
    briefingTime: 'Briefing időpontja',
    partnerDone: 'Szóljon a másik családi felhasználónak, ha készre jelölök egy teendőt',
    saving: 'Mentés…',
    loading: 'Betöltés…',
    saved: 'Mentve.',
    saveError: 'A beállítást nem sikerült menteni. Az előző érték visszaállítva.',
    familyMembers: 'Családtagok',
    account: 'Fiók és értesítések',
    signedIn: 'Belépett fiók',
    notifications: 'Értesítések',
    enabled: 'Bekapcsolva ezen az eszközön.',
    signOut: 'Kijelentkezés',
    help: 'Súgó',
    install: 'Telepítés a telefonra',
    captureHeading: 'Mit intézzünk?',
    captureDescription: 'Írd be vagy diktáld természetesen.',
    send: 'Küldés',
    greetingMorning: 'Jó reggelt',
    greetingDay: 'Szép napot',
    greetingEvening: 'Jó estét',
    noDeviceTimezone: 'Nem sikerült felismerni',
    previewNote: 'A további szövegek és az AI-válaszok fordítása külön fejlesztési lépés.',
  },
  'da-DK': {
    language: 'Sprog',
    detectedLanguage: 'Telefonens / browserens sprog',
    timezone: 'Tidszone',
    timezoneMatches: 'samme som på telefonen',
    detectedTimezone: 'Telefonens tidszone',
    savedTimezone: 'Tidszone for påmindelser',
    applyTimezone: 'Brug telefonens tidszone',
    timezoneSaved: 'Tidszonen for påmindelser er opdateret.',
    localeSaved: 'Sprogindstillingen er gemt.',
    localeError: 'Sprogindstillingen kunne ikke gemmes.',
    timezoneError: 'Tidszonen kunne ikke ændres.',
    settings: 'Indstillinger',
    appearance: 'Udseende',
    systemAppearance: 'Følg systemet',
    lightAppearance: 'Lyst',
    darkAppearance: 'Mørkt',
    morningBriefing: 'Morgenoverblik',
    briefingTime: 'Tidspunkt for morgenoverblik',
    partnerDone: 'Giv den anden familiebruger besked, når jeg afslutter en opgave',
    saving: 'Gemmer…',
    loading: 'Indlæser…',
    saved: 'Gemt.',
    saveError: 'Indstillingen kunne ikke gemmes. Den tidligere værdi er gendannet.',
    familyMembers: 'Familiemedlemmer',
    account: 'Konto og notifikationer',
    signedIn: 'Logget ind som',
    notifications: 'Notifikationer',
    enabled: 'Aktiveret på denne enhed.',
    signOut: 'Log ud',
    help: 'Hjælp',
    install: 'Installer på telefonen',
    captureHeading: 'Hvad skal vi ordne?',
    captureDescription: 'Skriv eller indtal din opgave på dansk. Gennemgå oplysningerne før du gemmer.',
    send: 'Send',
    greetingMorning: 'Godmorgen',
    greetingDay: 'Goddag',
    greetingEvening: 'Godaften',
    noDeviceTimezone: 'Kunne ikke registreres',
    previewNote: 'Du kan nu skrive eller indtale opgaver på dansk.',
  },
} as const

export type UiMessage = keyof typeof messages['hu-HU']

export function uiText(locale: AppLocale, key: UiMessage): string {
  return messages[locale][key]
}

export function detectDeviceLanguage(): string {
  if (typeof navigator === 'undefined') return 'hu-HU'
  return navigator.languages?.find((language) => Boolean(language))
    ?? navigator.language
    ?? 'hu-HU'
}

export function detectAppLocale(): AppLocale {
  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem(APP_LOCALE_STORAGE_KEY)
      if (saved === 'da-DK' || saved === 'hu-HU') return saved
    } catch {
      // A tároló tiltása nem akadályozhatja a nyelvfelismerést.
    }
  }

  if (typeof navigator === 'undefined') return 'hu-HU'
  const choices = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of choices) {
    const code = String(language ?? '').toLowerCase().split('-')[0]
    if (code === 'da') return 'da-DK'
    if (code === 'hu') return 'hu-HU'
  }
  return 'hu-HU'
}

export function rememberAppLocale(locale: AppLocale) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(APP_LOCALE_STORAGE_KEY, locale)
  } catch {
    // A nyelv ettől még az aktuális munkamenetben használható.
  }
}

export function detectDeviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}
