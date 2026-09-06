import { Hono } from "hono";

const app = new Hono();

const json = (c, data, status = 200) => c.json(data, status);
const now = () => Date.now();
const newId = () => crypto.randomUUID();
const randomToken = () => crypto.randomUUID() + crypto.randomUUID();

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = { day: 1, week: 7, twoweek: 14, month: 30 };
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days
const REMINDER_WINDOW_MS = 2 * DAY_MS; // send reminder when <=48h from expiry

/* ================================================================== *
 * Cookie + session helpers
 * ================================================================== */

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function cookieHeader(name, value, { maxAge, httpOnly = true } = {}) {
  let parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", "Secure"];
  if (httpOnly) parts.push("HttpOnly");
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

async function getSessionUser(c) {
  const cookies = parseCookies(c.req.raw);
  const sessionId = cookies["session"];
  if (!sessionId) return null;
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`
  ).bind(sessionId).first();
  if (!row || row.expires_at < now()) return null;
  return { id: row.id, email: row.email, name: row.name, picture: row.picture };
}

/* ================================================================== *
 * HMAC signing for one-click "extend" email links (no login required)
 * ================================================================== */

async function signExpenseId(secret, expenseId) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expenseId));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/* ================================================================== *
 * Auth routes
 * ================================================================== */

app.get("/auth/google/login", async (c) => {
  const state = randomToken();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", c.env.GOOGLE_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": cookieHeader("oauth_state", state, { maxAge: 600 }),
    },
  });
});

app.get("/auth/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookies = parseCookies(c.req.raw);

  if (!code || !state || state !== cookies["oauth_state"]) {
    return c.text("Login failed: invalid state. Please try again.", 400);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: c.env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return c.text("Login failed while exchanging code.", 400);
  const tokenData = await tokenRes.json();

  const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!profileRes.ok) return c.text("Login failed while fetching profile.", 400);
  const profile = await profileRes.json();

  let user = await c.env.DB.prepare("SELECT id FROM users WHERE google_sub = ?").bind(profile.sub).first();
  let userId;
  if (user) {
    userId = user.id;
    await c.env.DB.prepare("UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?")
      .bind(profile.email, profile.name, profile.picture || null, userId).run();
  } else {
    userId = newId();
    await c.env.DB.prepare(
      "INSERT INTO users (id, google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userId, profile.sub, profile.email, profile.name, profile.picture || null, now()).run();
  }

  const sessionId = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionId, userId, now() + SESSION_MAX_AGE_S * 1000, now()).run();

  return new Response(null, {
    status: 302,
    headers: {
      Location: c.env.APP_URL || "/",
      "Set-Cookie": cookieHeader("session", sessionId, { maxAge: SESSION_MAX_AGE_S }),
    },
  });
});

app.post("/auth/logout", async (c) => {
  const cookies = parseCookies(c.req.raw);
  if (cookies["session"]) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(cookies["session"]).run();
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookieHeader("session", "", { maxAge: 0 }),
    },
  });
});

app.get("/api/me", async (c) => {
  const user = await getSessionUser(c);
  return json(c, { user });
});

app.get("/api/my/groups", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return json(c, { error: "Not signed in." }, 401);
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, currency, created_at FROM groups WHERE created_by = ? ORDER BY created_at DESC"
  ).bind(user.id).all();
  return json(c, { groups: results });
});

/* ================================================================== *
 * Groups / members / expenses
 * ================================================================== */

app.post("/api/groups", async (c) => {
  const user = await getSessionUser(c);
  const body = await c.req.json().catch(() => ({}));
  const name = (body.name || "").trim();
  if (!name) return json(c, { error: "Group name is required." }, 400);

  const retentionKeys = [...Object.keys(RETENTION_DAYS), "permanent"];
  const retention = retentionKeys.includes(body.retention) ? body.retention : "month";

  const id = newId();
  const currency = (body.currency || "$").slice(0, 3);

  try {
    await c.env.DB.prepare(
      "INSERT INTO groups (id, name, currency, retention, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, name.slice(0, 60), currency, retention, now(), user ? user.id : null).run();
  } catch (err) {
    if (String(err.message || err).toLowerCase().includes("unique")) {
      return json(c, { error: "That group name is taken — try something more unique." }, 409);
    }
    throw err;
  }

  return json(c, { id, name, currency, retention }, 201);
});

app.get("/api/groups/:id", async (c) => {
  const groupId = c.req.param("id");
  const user = await getSessionUser(c);

  const group = await c.env.DB.prepare("SELECT * FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return json(c, { error: "Group not found." }, 404);

  const { results: members } = await c.env.DB.prepare(
    "SELECT id, name FROM members WHERE group_id = ? ORDER BY created_at ASC"
  ).bind(groupId).all();

  const { results: expenses } = await c.env.DB.prepare(
    `SELECT id, description, amount, paid_by, created_at, expires_at
     FROM expenses
     WHERE group_id = ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC`
  ).bind(groupId, now()).all();

  const { results: splits } = await c.env.DB.prepare(
    `SELECT es.expense_id, es.member_id, es.share_amount
     FROM expense_splits es
     JOIN expenses e ON e.id = es.expense_id
     WHERE e.group_id = ? AND (e.expires_at IS NULL OR e.expires_at > ?)`
  ).bind(groupId, now()).all();

  const { balances, settlements } = computeBalances(members, expenses, splits);

  return json(c, {
    group,
    members,
    expenses,
    balances,
    settlements,
    currentUser: user,
  });
});

app.post("/api/groups/:id/members", async (c) => {
  const groupId = c.req.param("id");
  const group = await c.env.DB.prepare("SELECT id FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return json(c, { error: "Group not found." }, 404);

  const body = await c.req.json().catch(() => ({}));
  const name = (body.name || "").trim();
  if (!name) return json(c, { error: "Name is required." }, 400);

  const id = newId();
  await c.env.DB.prepare(
    "INSERT INTO members (id, group_id, name, created_at) VALUES (?, ?, ?, ?)"
  ).bind(id, groupId, name.slice(0, 40), now()).run();

  return json(c, { id, name }, 201);
});

app.post("/api/groups/:id/expenses", async (c) => {
  const groupId = c.req.param("id");
  const user = await getSessionUser(c);
  const group = await c.env.DB.prepare("SELECT id, retention FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return json(c, { error: "Group not found." }, 404);

  const body = await c.req.json().catch(() => ({}));
  const description = (body.description || "").trim();
  const amount = Number(body.amount);
  const paidBy = body.paid_by;
  const splitType = body.split_type === "custom" ? "custom" : "equal";
  const rawSplits = Array.isArray(body.splits) ? body.splits : [];

  if (!description) return json(c, { error: "Description is required." }, 400);
  if (!amount || amount <= 0) return json(c, { error: "Amount must be greater than zero." }, 400);
  if (!paidBy) return json(c, { error: "Choose who paid." }, 400);
  if (rawSplits.length === 0) return json(c, { error: "Pick at least one person to split with." }, 400);

  const memberIds = rawSplits.map((s) => s.member_id).concat(paidBy);
  const { results: validMembers } = await c.env.DB.prepare(
    `SELECT id FROM members WHERE group_id = ? AND id IN (${memberIds.map(() => "?").join(",")})`
  ).bind(groupId, ...memberIds).all();
  const validIds = new Set(validMembers.map((m) => m.id));
  if (!validIds.has(paidBy) || rawSplits.some((s) => !validIds.has(s.member_id))) {
    return json(c, { error: "One of the selected people isn't in this group." }, 400);
  }

  // Retention is a property of the group (chosen once at creation), so every
  // expense in the group inherits the same expiry policy. No per-expense cap.
  const expiresAt = group.retention === "permanent"
    ? null
    : now() + (RETENTION_DAYS[group.retention] || RETENTION_DAYS.month) * DAY_MS;

  let splits;
  if (splitType === "equal") {
    const n = rawSplits.length;
    const base = Math.floor((amount / n) * 100) / 100;
    let remainder = Math.round((amount - base * n) * 100);
    splits = rawSplits.map((s, i) => ({ member_id: s.member_id, share_amount: base + (i < remainder ? 0.01 : 0) }));
  } else {
    const sum = rawSplits.reduce((acc, s) => acc + Number(s.amount || 0), 0);
    if (Math.abs(sum - amount) > 0.01) return json(c, { error: "Custom amounts must add up to the total." }, 400);
    splits = rawSplits.map((s) => ({ member_id: s.member_id, share_amount: Number(s.amount) }));
  }

  const expenseId = newId();
  const stmts = [
    c.env.DB.prepare(
      "INSERT INTO expenses (id, group_id, description, amount, paid_by, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(expenseId, groupId, description.slice(0, 80), amount, paidBy, now(), expiresAt, user ? user.id : null),
    ...splits.map((s) =>
      c.env.DB.prepare(
        "INSERT INTO expense_splits (id, expense_id, member_id, share_amount) VALUES (?, ?, ?, ?)"
      ).bind(newId(), expenseId, s.member_id, s.share_amount)
    ),
  ];
  await c.env.DB.batch(stmts);

  return json(c, { id: expenseId, expires_at: expiresAt }, 201);
});

app.delete("/api/groups/:id/expenses/:expenseId", async (c) => {
  const groupId = c.req.param("id");
  const expenseId = c.req.param("expenseId");

  const expense = await c.env.DB.prepare(
    "SELECT id FROM expenses WHERE id = ? AND group_id = ?"
  ).bind(expenseId, groupId).first();
  if (!expense) return json(c, { error: "Expense not found." }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM expense_splits WHERE expense_id = ?").bind(expenseId),
    c.env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(expenseId),
  ]);

  return json(c, { ok: true });
});

// One-click "extend 30 days" link from reminder emails — no login required,
// authenticated instead by an HMAC signature tied to the expense id.
app.get("/api/expenses/:id/extend", async (c) => {
  const expenseId = c.req.param("id");
  const sig = c.req.query("sig");
  const expected = await signExpenseId(c.env.EXTEND_SECRET, expenseId);
  if (!sig || sig !== expected) return c.text("This extend link is invalid or has expired.", 400);

  const expense = await c.env.DB.prepare("SELECT group_id FROM expenses WHERE id = ?").bind(expenseId).first();
  if (!expense) return c.text("That expense no longer exists.", 404);

  await c.env.DB.prepare(
    "UPDATE expenses SET expires_at = ?, reminded_at = NULL WHERE id = ?"
  ).bind(now() + 30 * DAY_MS, expenseId).run();

  return new Response(null, {
    status: 302,
    headers: { Location: `${c.env.APP_URL}/?g=${expense.group_id}&extended=1` },
  });
});

/* ================================================================== *
 * Balance math
 * ================================================================== */

function computeBalances(members, expenses, splits) {
  const net = new Map(members.map((m) => [m.id, 0]));
  const expenseById = new Map(expenses.map((e) => [e.id, e]));
  for (const e of expenses) if (net.has(e.paid_by)) net.set(e.paid_by, net.get(e.paid_by) + e.amount);
  for (const s of splits) {
    if (!expenseById.has(s.expense_id)) continue;
    if (net.has(s.member_id)) net.set(s.member_id, net.get(s.member_id) - s.share_amount);
  }
  const balances = members.map((m) => ({ id: m.id, name: m.name, net: Math.round(net.get(m.id) * 100) / 100 }));
  return { balances, settlements: simplifyDebts(balances) };
}

function simplifyDebts(balances) {
  const creditors = balances.filter((b) => b.net > 0.005).map((b) => ({ ...b }));
  const debtors = balances.filter((b) => b.net < -0.005).map((b) => ({ ...b, net: -b.net }));
  creditors.sort((a, b) => b.net - a.net);
  debtors.sort((a, b) => b.net - a.net);
  const settlements = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].net, creditors[j].net);
    if (pay > 0.005) settlements.push({ from: debtors[i].name, to: creditors[j].name, amount: Math.round(pay * 100) / 100 });
    debtors[i].net -= pay;
    creditors[j].net -= pay;
    if (debtors[i].net <= 0.005) i++;
    if (creditors[j].net <= 0.005) j++;
  }
  return settlements;
}

/* ================================================================== *
 * Static assets fallback (the SPA)
 * ================================================================== */

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

/* ================================================================== *
 * Scheduled: daily cleanup + expiry reminder emails
 * ================================================================== */

async function sendReminderEmail(env, expense, group, toEmail) {
  const sig = await signExpenseId(env.EXTEND_SECRET, expense.id);
  const extendUrl = `${env.APP_URL}/api/expenses/${expense.id}/extend?sig=${sig}`;
  const groupUrl = `${env.APP_URL}/?g=${group.id}`;
  const daysLeft = Math.max(1, Math.ceil((expense.expires_at - Date.now()) / DAY_MS));

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [toEmail],
      subject: `"${expense.description}" is expiring in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
      html: `
        <p>Hey,</p>
        <p>Your expense <strong>${escapeHtml(expense.description)}</strong> (${group.currency}${expense.amount.toFixed(2)})
        in the group <strong>${escapeHtml(group.name)}</strong> will be automatically deleted in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.</p>
        <p>If it's already settled, you can ignore this — it'll clean itself up.
        If you'd like to keep it a little longer, click below:</p>
        <p><a href="${extendUrl}" style="background:#3D6EF0;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Extend by 30 days</a></p>
        <p><a href="${groupUrl}">Open the group</a></p>
      `,
    }),
  }).catch(() => {}); // best-effort; a failed email should not block the cron
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function scheduled(event, env, ctx) {
  const nowTs = Date.now();

  // 1) Reminder emails for expenses expiring within the window.
  const { results: dueForReminder } = await env.DB.prepare(
    `SELECT e.id, e.description, e.amount, e.expires_at, e.group_id, u.email as user_email
     FROM expenses e
     JOIN users u ON u.id = e.created_by
     WHERE e.expires_at IS NOT NULL AND e.expires_at > ? AND e.expires_at <= ? AND e.reminded_at IS NULL`
  ).bind(nowTs, nowTs + REMINDER_WINDOW_MS).all();

  for (const exp of dueForReminder) {
    const group = await env.DB.prepare("SELECT id, name, currency FROM groups WHERE id = ?").bind(exp.group_id).first();
    if (group) await sendReminderEmail(env, exp, group, exp.user_email);
    await env.DB.prepare("UPDATE expenses SET reminded_at = ? WHERE id = ?").bind(nowTs, exp.id).run();
  }

  // 2) Delete anything already expired.
  const { results: expired } = await env.DB.prepare(
    "SELECT id FROM expenses WHERE expires_at IS NOT NULL AND expires_at <= ?"
  ).bind(nowTs).all();
  if (expired.length > 0) {
    const ids = expired.map((e) => e.id);
    const placeholders = ids.map(() => "?").join(",");
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM expense_splits WHERE expense_id IN (${placeholders})`).bind(...ids),
      env.DB.prepare(`DELETE FROM expenses WHERE id IN (${placeholders})`).bind(...ids),
    ]);
  }
}

export default { fetch: app.fetch, scheduled };
