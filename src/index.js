import { Hono } from "hono";
import { json } from "./lib/http.js";
import { now, newId, randomToken, signExpenseId } from "./lib/crypto.js";
import { parseCookies, cookieHeader } from "./lib/cookies.js";
import {
  DAY_MS,
  RETENTION_DAYS,
  buildGroupState,
  computeExpiryForNewExpense,
} from "./services/group-state.js";
import { broadcastGroupState, scheduleGroupAlarm, connectToGroupRoom } from "./services/realtime.js";
import { GroupRoom } from "./durable-objects/group-room.js";

export { GroupRoom };

const app = new Hono();

const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

/* ================================================================== *
 * Session helper
 * ================================================================== */

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

  const state = await buildGroupState(c.env.DB, groupId, user);
  if (!state) return json(c, { error: "Group not found." }, 404);

  return json(c, state);
});

// Realtime channel for a group. No session/auth checks here on purpose — the
// DO never receives or trusts identity, it only relays whatever state the
// Worker's own mutation handlers hand it.
app.get("/api/groups/:id/socket", async (c) => {
  const groupId = c.req.param("id");
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected a WebSocket upgrade request.", 426);
  }
  return connectToGroupRoom(c.env, groupId, c.req.raw);
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

  const user = await getSessionUser(c);
  const state = await buildGroupState(c.env.DB, groupId, user);

  // The new member already has fresh state in this response; the broadcast
  // is for everyone *else* already in the group, so they see the arrival
  // live. Doesn't block this response.
  c.executionCtx.waitUntil(broadcastGroupState(c.env, groupId, state));

  return json(c, { id, name, state }, 201);
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
  const expiresAt = computeExpiryForNewExpense(group.retention);

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

  const state = await buildGroupState(c.env.DB, groupId, user);

  // Both run in the background after the response is sent — the person who
  // just added the expense already has `state` right here and shouldn't
  // wait on a DO round trip (broadcast) or an alarm-scheduling call to get
  // their own success response back.
  c.executionCtx.waitUntil(broadcastGroupState(c.env, groupId, state));
  if (expiresAt !== null) {
    c.executionCtx.waitUntil(
      scheduleGroupAlarm(c.env, groupId, { expiresAt, reminderAt: expiresAt - 2 * DAY_MS })
    );
  }

  return json(c, { id: expenseId, expires_at: expiresAt, state }, 201);
});

app.delete("/api/groups/:id/expenses/:expenseId", async (c) => {
  const groupId = c.req.param("id");
  const expenseId = c.req.param("expenseId");
  const user = await getSessionUser(c);

  const expense = await c.env.DB.prepare(
    "SELECT id FROM expenses WHERE id = ? AND group_id = ?"
  ).bind(expenseId, groupId).first();
  if (!expense) return json(c, { error: "Expense not found." }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM expense_splits WHERE expense_id = ?").bind(expenseId),
    c.env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(expenseId),
  ]);

  const state = await buildGroupState(c.env.DB, groupId, user);
  c.executionCtx.waitUntil(broadcastGroupState(c.env, groupId, state));

  return json(c, { ok: true, state });
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

  const newExpiresAt = now() + 30 * DAY_MS;
  await c.env.DB.prepare(
    "UPDATE expenses SET expires_at = ?, reminded_at = NULL WHERE id = ?"
  ).bind(newExpiresAt, expenseId).run();

  const state = await buildGroupState(c.env.DB, expense.group_id, null);
  c.executionCtx.waitUntil(broadcastGroupState(c.env, expense.group_id, state));
  c.executionCtx.waitUntil(
    scheduleGroupAlarm(c.env, expense.group_id, { expiresAt: newExpiresAt, reminderAt: newExpiresAt - 2 * DAY_MS })
  );

  return new Response(null, {
    status: 302,
    headers: { Location: `${c.env.APP_URL}/?g=${expense.group_id}&extended=1` },
  });
});

/* ================================================================== *
 * Static assets fallback (the SPA)
 * ================================================================== */

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default { fetch: app.fetch };
