# Sport diary

## Scope and privacy

The Telegram Mini App has a separate `/sport/` section. The reference Google
Sheet is read-only and is not a runtime dependency. Only its field structure
was used: no names, diary entries or personal goal values were imported.

All sport API reads, writes and exports are scoped to the signed Telegram user
ID and the current assistant allowlist. The administrator does not receive
another user's diary. The existing main bot keyboard and task capture remain
independent of sport questions.

No photo bytes, Telegram `file_id`, photo URL or original message content are
saved. A meal sent as a photo is processed from its text caption only. Telegram
itself still retains the photo in the conversation according to its own rules.
No vision model, paid AI API, calorie estimation or background analysis runs.

## Storage

Migration `cloudflare-worker/migrations/0005_add_sport.sql` adds:

- `sport_profiles`: personal IANA timezone and optional goals.
- `sport_days`: one row per owner and local calendar date, partial updates.
- `sport_meals`: individually editable meals with explicit calories and B/F/C.
- `sport_reminders`: independent daily local-time questions.
- `sport_prompts` and `sport_prompt_messages`: expiring question/reply routing.
- `sport_deliveries` and `sport_updates`: short-lived idempotency metadata.

Unknown measurements remain SQL NULL, not zero. Nutrition is tri-state.
Meal macros can be partial, so missing nutrients must not be reported as a
complete daily total. `nutrition_source` records manual provenance. The nullable
`media_id` reserves a future attachment boundary; current APIs never populate
it or accept files. Future image storage requires its own retention, access and
deletion rules, and explicit opt-in. An estimated value must remain distinguishable
from a manually entered one.

## API

Authenticated requests use `Authorization: tma <Telegram.WebApp.initData>`.
Responses and CSV exports use `Cache-Control: no-store`. User-controlled text in
CSV is escaped against spreadsheet formula injection.

- `GET /api/sport?from=YYYY-MM-DD&to=YYYY-MM-DD`: at most 93 days.
- `PUT /api/sport/days/:date`: partial daily measurement update.
- `POST /api/sport/meals`: stable client-generated id makes retries idempotent.
- `PATCH /api/sport/meals/:id` and `DELETE /api/sport/meals/:id`.
- `PUT /api/sport/settings`: atomically save timezone, own goals and up to 16 questions.
- `GET /api/sport/export?from=...&to=...&kind=days|meals`: private CSV.

There is no anonymous sport API, external coach access or Google Sheet write.

## Questions and replies

Questions are disabled for new users until they explicitly save a schedule.
Kinds are `sleep`, `meal`, `water`, `steps` and combined `evening`; multiple meal times and labels are
supported. The user's timezone, not the server clock, determines the date/time.

Cloudflare cron `* * * * *` checks an indexed due-time queue. The independent
morning briefing retains cron `0 5 * * *`. `SPORT_ENABLED=false` disables sport
question handling and scheduling without disabling tasks or the morning briefing.

Every occurrence is claimed once. Delayed questions older than 30 minutes are
skipped to avoid flooding after downtime. Failed/ambiguous sends are recorded,
not blindly retried, because Telegram may have received the first request.
Queue capacity is 20 due questions per minute; this is a personal-assistant scale
implementation, not a mass mailing service. User blocking is rechecked before
sending each question.

Questions use Telegram ForceReply and expire after 18 hours. Replies to the
original or a clarification are intercepted before task capture and scoped to
the question's owner, date and kind. An expired/completed question cannot silently
create a task or add a second meal. Unrelated chat messages remain tasks.

Examples of explicitly supplied values:

- Sleep: `Хорошо, спал 7,5 часов`.
- Evening: `Воды 2 л, шаги 8500, питание по плану`.
- Meal text or photo caption: `Овсянка, 400 ккал, Б 20 Ж 10 У 55`.
- Manual chat entry: `/sport сон Спал 8 часов` or `/sport еда Рис, 450 ккал, Б 15 Ж 10 У 70`.
- `/sport` opens the section without adding another permanent keyboard row.

Units are required for water. Unparseable/out-of-range values are not guessed;
the question remains open. A positive acknowledgement is sent only after the
database confirms the write. Send failures never turn a sport reply into a task.

## Rollout

Apply migration 0005 to the existing TASKS_DB before publishing the Worker.
Do not replace bindings, rotate secrets, change the Telegram webhook or modify
the Google Sheet. Deploy tested static assets and the Worker from the same
revision. Configure a user's schedule explicitly; no reminders are enabled just
because the feature is deployed.

Local checks use the real SQLite schema through a D1-compatible fixture,
signed test Mini App data and fictional users only. The browser preview's
`?demo=1` data is fictional and never synchronized to a real account.
