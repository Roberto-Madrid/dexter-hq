---
name: dexter-i18n-visual
description: Required i18n and visual QA for Dexter. apps that support EN/ES. Load before any copy, locale, or user-visible UI change, and before accepting such a PR.
---

# i18n visual QA (EN/ES)

The owner has already caught untranslated Products and Appointments after
PRs that claimed “everything” was translated. Do not repeat that.

Supported locales: **English and Spanish only**.

## Before you call it done

1. List every tab and route the user can actually open (customer and
   barber, including login/demo). That list is the test plan.
2. Run the app. Switch to Spanish. Open **each** tab. Screenshot each.
   English-only chrome, labels, empty states, buttons, or catalog names
   on any tab is a fail.
3. `pnpm check` passing is not visual evidence.

## Dynamic catalog, not a seed map

Hard-coding `svc-cut` → “Corte” is not enough. New services and products
the barber adds later must display in the current locale without a
follow-up code change. Prefer storing both languages on the record, or
translating at create time. A leftover English name in Appointments or
Products is a fail even if the page title is translated.

## Prompt shape for workers

Include in the brief: the tab list to screenshot, “locale `es` on every
tab”, “new services auto-translate”, and “open PR ready, not draft”.
