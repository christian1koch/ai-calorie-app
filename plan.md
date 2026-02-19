# AI Calorie App Plan (MVP)

## Goal
Build a simple AI-powered calorie tracker where users log meals in natural English, and the app stores daily calorie and macro totals using Germany-relevant food data.

## MVP Scope
- Log meals and snacks from free-text input (intent: `log_meal`).
- Accept user-provided grams/kcal when included.
- Look up missing nutrition values from Germany-relevant sources.
- Save entries with date/time in `Europe/Berlin`.
- Show daily totals (kcal, protein, carbs, fat).
- Allow quick correction of a logged entry.

## Core Rules
- User-provided values override lookup values.
- If quantity is unclear, estimate and mark confidence.
- Keep final nutrition math deterministic in code.
- Return assumptions clearly in the response.

## Tech (Initial)
- Next.js (frontend + API routes)
- TypeScript
- PostgreSQL + Prisma
- OpenAI API + Zod for structured parsing
- date-fns/date-fns-tz for Berlin-local day handling

## Main Endpoints
- `POST /api/log-meal`
- `GET /api/day-summary?date=YYYY-MM-DD`
- `PATCH /api/entry/:id`
- `DELETE /api/entry/:id`

## First Milestones
1. Data model + migrations.
2. `log-meal` pipeline (parse -> lookup -> calculate -> store).
3. Day summary endpoint + simple dashboard view.
4. Edit/delete entry flows.
5. Basic tests for parsing and total calculations.
