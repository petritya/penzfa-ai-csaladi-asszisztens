-- HU/DK nyelvválasztás felhasználónként. NULL = a készülék nyelvét használjuk.
-- Meglévő időzónákat és értesítésbeállításokat nem írunk át.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS ui_locale text
    CONSTRAINT user_settings_ui_locale_supported
    CHECK (ui_locale IN ('hu-HU', 'da-DK'));
