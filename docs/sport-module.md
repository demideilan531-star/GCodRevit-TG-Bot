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

There is no anonymous sport API or external coach access. The optional Google
Sheet mirror is configured separately below.

## Questions and replies

Questions are disabled for new users until they explicitly save a schedule.
Kinds are `sleep`, `meal`, `water`, `steps` and combined `evening`; multiple meal times and labels are
supported. The user's timezone, not the server clock, determines the date/time.

Migration `0007_add_sport_reminder_mode.sql` adds a per-reminder `mode`:
`notification` (default) or `question`. Existing reminders become notifications;
their times and enabled flags are not changed. Notifications send a normal message
with an inline "Open diary" Mini App button for the occurrence's date. They do
not create a reply prompt or request a chat response. Only explicit `question`
mode uses the reply workflow below. The settings screen supports up to sixteen
independent reminders, including several meals, and a separate mode for each.
Suggested sleep/breakfast/lunch/dinner/evening entries are disabled until saved
with their toggles on. An explicitly added entry starts enabled in the unsaved
form; it is not scheduled until Save succeeds.

Cloudflare cron `* * * * *` checks an indexed due-time queue. The independent
morning briefing retains cron `0 5 * * *`. `SPORT_ENABLED=false` disables sport
question handling and scheduling without disabling tasks or the morning briefing.

Every occurrence is claimed once. Delayed reminders older than 30 minutes are
skipped to avoid flooding after downtime. Failed/ambiguous sends are recorded,
not blindly retried, because Telegram may have received the first request.
Queue capacity is 20 due questions per minute; this is a personal-assistant scale
implementation, not a mass mailing service. User blocking is rechecked before
sending each question.

Question-mode reminders use Telegram ForceReply and expire after 18 hours. Replies to the
original or a clarification are intercepted before task capture and scoped to
the question's owner, date and kind. An expired/completed question cannot silently
create a task or add a second meal. Unrelated chat messages remain tasks.

Examples of explicitly supplied values:

- Sleep: `Хорошо, спал 7,5 часов`.
- Evening: `Воды 2 л, шаги 8500, питание по плану`.
- Meal text or photo caption: `Овсянка, 400 ккал, Б 20 Ж 10 У 55`.
- Manual chat entry: `/sport сон Спал 8 часов` or `/sport еда Рис, 450 ккал, Б 15 Ж 10 У 70`.
- `/sport` and the private chat's Sport button open the section. The button is
  shown for both administrator and ordinary users only while Sport is enabled;
  role-specific channel controls remain restricted. Existing Telegram keyboards
  refresh on the next `/start` or regular bot response with a keyboard.

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

## Optional daily Google Sheet mirror

Migration `0006_add_sport_sheet_exports.sql` adds one private, opt-in destination
per Telegram owner. It does not change the daily diary schema or the reference
spreadsheet. The original sample spreadsheet ID is explicitly denied as a write
destination, even if it is accidentally pasted into Settings.

The URL setting is separate from personal goals and reminder schedules. Saving a
URL does not grant Google access. The Worker needs a dedicated Google service
account JSON in the `GOOGLE_SHEETS_SERVICE_ACCOUNT` Cloudflare Secret. It uses only
the Sheets OAuth scope, not Gmail/Drive-wide account access. There is no domain-wide
delegation, user password or OpenAI API key. Never commit/download this credential
into the repository or print it to logs. Give its email Editor access only to the
chosen destination copies.

Before enabling an unverified destination, the user proves edit access by adding
the displayed verification code to the spreadsheet title once. This prevents an
allowlisted user from binding another person's already-shared destination just by
knowing its URL. The code can be removed from the title after verification; no
verification cells or extra tabs are inserted. One sheet cannot be registered to
two bot users. Disabling or replacing a destination invalidates any running lease.

The target must retain exactly the example's three named tabs. Export rejects an
additional/missing tab or mismatched daily headers rather than silently inventing
a layout. After edit-access verification, enabling the destination sets only the
diary's F2:F dropdown to the five training types already present in the reference
dictionary and the bot. This fixes the sample's shorter three-choice rule and
confirms that the service account can edit the destination. Values, formatting,
other validation rules and the original reference remain untouched.

| Target | Value from the bot database |
| --- | --- |
| Diary A | Local date as a native Sheets date number |
| Diary B | Weight, kg |
| Diary C | Sleep, hours |
| Diary D | Water, liters (converted from ml) |
| Diary E | Steps |
| Diary F | Russian training label |
| Diary G | Nutrition boolean, blank when unknown |
| Diary H | Mood score and label |
| Diary I | Own comment plus named meals and manual calories/B/F/C |
| Diary J | Own coach note; an existing sheet note is retained when the database note is empty |
| Goals B2:B5 | Configured sleep, steps, water liters, weight goals only |

No extra calorie columns or tabs are introduced. The dashboard's formulas, charts,
headers and layout are not overwritten. Date rows are matched and updated in place;
missing dates are appended. New rows inherit the template's format and validation
in separate requests, retaining dropdowns and nutrition checkboxes. Sheets writes
use RAW values, so food names and notes cannot become formulas. Unknown nutrients
remain unknown and partial meal sums are labeled as such inside the comment.

The existing minute scheduler runs an initial synchronization on the next tick
after a new destination is enabled and verified, then at/after 03:15 in each user's
timezone at most once per local date. An initial success before 03:15 does not
consume that day's scheduled run or delay it with the error retry backoff.
It runs only for enabled, verified destinations
whose owners still have access. No credentials means no Google calls and no fake
success. Database leases prevent concurrent exports; retries are date-upserts and
are delayed at least an hour after failure. Requests are bounded to 1.5 MB/300 rows
per value batch. This is a personal diary mirror, not an unbounded data warehouse
(limits: 10,000 diary days, 100,000 meals and 20,000 destination rows).

The UI shows the real connection state and last successful synchronization time.
Adding a service account or pasting a URL never imports or edits the reference
spreadsheet. Test a separate, explicitly designated destination before enabling a
real user's schedule.
