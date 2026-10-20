# HU–DK Supabase Auth e-mail sablonok

A frontend regisztrációkor, a Core pedig családi meghíváskor `ui_locale` metaadatot ad át a Supabase Authnak.

## Confirm sign up

Subject:

`{{ if eq .Data.ui_locale "da-DK" }}Bekræft din e-mailadresse – AI-familieassistent{{ else }}Erősítsd meg az e-mail-címed – AI családi asszisztens{{ end }}`

Body: `confirmation.html`

## Invite user

Subject:

`{{ if eq .Data.ui_locale "da-DK" }}Invitation – AI-familieassistent{{ else }}Meghívást kaptál – AI családi asszisztens{{ end }}`

Body: `invite.html`

A sablonok a Supabase hosted projektben az Authentication → Email Templates oldalon állítandók be.
