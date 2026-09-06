# LedgerMate

A free, installable-feeling web app for splitting expenses with friends —
no sign-up required to use it, optional Google sign-in for account tracking
and reminder emails, auto-expiring expenses so the free database never
grows without bound, and a charts dashboard.

## What's new in this version

1. **Realtime sync**: every group has one Durable Object ("GroupRoom")
   holding a live WebSocket connection per open tab. Any change — an
   expense added or deleted, someone joining — is pushed to everyone else
   with the group open, including the Balances and Dashboard charts, which
   re-render from the same pushed state. Uses the Hibernatable WebSockets
   API, so an open-but-idle tab doesn't keep anything pinned in memory.
2. **No more daily cron sweep**: expiry cleanup and 48h reminder emails are
   now driven by each group's own Durable Object alarm — it wakes up
   exactly when *that* group has something due, instead of a single job
   scanning every expense in the database once a day. Existing groups
   self-heal their schedule the first time anyone opens them.
3. **Currency per group** — chosen once at creation (₹, $, €, £, ¥, and a
   few others), shown consistently everywhere an amount appears.
4. **Unique group names** — every group's name must be unique (case-
   insensitive) across the whole app, enforced at the database level.
5. **Group-level retention** — the creator picks a retention policy once,
   when the group is created (1 day / 1 week / 2 weeks / 1 month /
   permanent). Every expense added to that group inherits it — no
   per-expense choice, and no cap on how many expenses a group can have.
6. **Auto-join via link** — anyone who opens a group's share link and
   isn't already a recognized member is asked their name once, then is
   added to the group automatically. That identity is remembered in the
   browser (localStorage), so "Paid by" defaults to them from then on.
7. **Google Sign-In (optional)** — lets someone see "My Groups" and get
   reminder emails. The app fully works without signing in.
8. **Redesign**: Manrope/Inter fonts, a violet→blue accent, bottom-sheet
   modals, a splash animation, one consistent floating "+" control on
   every screen size (mobile and desktop).
9. **Dashboard tab**: total spent, expense count, a "who paid what"
   doughnut chart, and a net-balance bar chart (Chart.js via CDN) — all
   realtime.

## Code layout

```
src/
  index.js                    Hono app — HTTP routes only
  durable-objects/
    group-room.js             GroupRoom DO: realtime fan-out + per-group alarm
  services/
    group-state.js            Core domain logic: balances, retention, state shape
    realtime.js                Worker-side helpers for reaching a group's DO
  lib/
    http.js, crypto.js, cookies.js, email.js   generic utilities
```
`group-state.js` is the single source of truth for what a group's state
looks like and how balances are computed — both the HTTP routes and the
Durable Object import it, so there's exactly one implementation.

## One-time setup

```bash
npm install
npx wrangler login
npm run db:create   # paste the printed database_id into wrangler.jsonc
```

### 1. Google OAuth (for sign-in)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Create a project (or use an existing one) → **Create Credentials** →
   **OAuth client ID** → Application type: **Web application**.
3. Under **Authorized redirect URIs**, add:
   `https://<your-worker-url>/auth/google/callback`
4. Copy the **Client ID** and **Client Secret**.
5. In `wrangler.jsonc`, set:
   - `GOOGLE_CLIENT_ID` → your client ID
   - `GOOGLE_REDIRECT_URI` → `https://<your-worker-url>/auth/google/callback`
   - `APP_URL` → `https://<your-worker-url>`
6. Store the client secret and a random session-signing secret (never put
   secrets directly in `wrangler.jsonc`):
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put EXTEND_SECRET      # any long random string
   ```

### 2. Resend (for reminder emails)

1. Sign up free at [resend.com](https://resend.com) (3,000 emails/month free).
2. Get an API key from the dashboard.
3. **Important**: Resend's default test sender (`onboarding@resend.dev`)
   can only deliver to the email address you signed up with. To email your
   actual users, you need to **verify a domain you own** in Resend (Domains
   → Add Domain → add the DNS records they give you). This takes a few
   minutes and is free.
4. Once verified, update `RESEND_FROM` in `wrangler.jsonc`, e.g.
   `"LedgerMate <notifications@yourdomain.com>"`.
5. Store the API key as a secret:
   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```
   If you skip Resend setup entirely, the app still works fine — reminder
   emails will just silently fail to send (cleanup still happens on schedule).

### 3. Run migrations

```bash
npm run db:migrate:local     # for local `wrangler dev`
npm run db:migrate:remote    # for production
```

### 4. Deploy

```bash
npm run deploy
```

## How it works day-to-day

- Anyone can create a group with no login and share the link — works exactly
  as before.
- If someone signs in with Google before/while using a group, expenses they
  add are tied to their account: they show up under "My Groups" on the home
  screen, and they'll get a reminder email before any of their time-limited
  expenses auto-delete.
- Each group's Durable Object schedules its own alarm for whatever's due
  next in that group (a 48h-before reminder email, or an expense's actual
  deletion time). It fires, does that work, pushes the updated state to
  anyone with the group open, then reschedules itself for the next thing —
  no global cron job involved.

## Adjusting the retention options

Top of `src/services/group-state.js`:
```js
const RETENTION_DAYS = { day: 1, week: 7, twoweek: 14, month: 30 };
const REMINDER_WINDOW_MS = 2 * DAY_MS; // how far ahead reminders are sent
```
