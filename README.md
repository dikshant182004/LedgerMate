# LedgerMate

A free, installable-feeling web app for splitting expenses with friends —
no sign-up required to use it, optional Google sign-in for account tracking
and reminder emails, auto-expiring expenses so the free database never
grows without bound, and a charts dashboard.

## What's new in this version

1. **Unique group names** — every group's name must be unique (case-
   insensitive) across the whole app, enforced at the database level.
2. **Group-level retention** — the creator picks a retention policy once,
   when the group is created (1 day / 1 week / 2 weeks / 1 month /
   permanent). Every expense added to that group inherits it — there's no
   per-expense choice or override anymore, and no cap on how many
   expenses (permanent or otherwise) a group can have.
3. **Auto-join via link** — anyone who opens a group's share link and
   isn't already a recognized member is asked their name once, then is
   added to the group automatically. That identity is remembered in the
   browser (localStorage), so the "Paid by" field defaults to them on
   every future visit.
4. **Google Sign-In (optional)** — lets someone see "My Groups" and get
   reminder emails. The app fully works without signing in (anonymous
   share-link groups, like before).
5. **Reminder emails** — ~48h before an expense auto-deletes, its creator
   (if signed in) gets an email with a one-click "extend 30 days" link.
   Sent via [Resend](https://resend.com).
6. **Redesign**: Manrope/Inter fonts, a violet→blue accent, bottom-sheet
   modals, tab transitions, a splash animation on load.
7. **Dashboard tab**: total spent, expense count, a "who paid what"
   doughnut chart, and a net-balance bar chart (Chart.js via CDN).
8. **New app icon** — receipt + checkmark mark, used for the home screen
   icon, favicon, and splash animation.

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
- The daily cron job (`0 3 * * *` UTC) does two things: sends reminder
  emails for anything expiring in the next 48h, then deletes anything
  already past its expiry.

## Adjusting the retention options

Top of `src/index.js`:
```js
const RETENTION_DAYS = { day: 1, week: 7, twoweek: 14, month: 30 };
const REMINDER_WINDOW_MS = 2 * DAY_MS; // how far ahead reminders are sent
```
