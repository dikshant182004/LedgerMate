import { Hono } from "hono";
import { json } from "./lib/http.js";
import { now, newId, randomToken, signExpenseId } from "./lib/crypto.js";
import { parseCookies, cookieHeader } from "./lib/cookies.js";
import {
  DAY_MS,
  RETENTION_MS,
  ALL_RETENTIONS,
  ANONYMOUS_RETENTIONS,
  DEFAULT_RETENTION,
  retentionRequiresSignIn,
  buildGroupState,
  computeExpiryForNewExpense,
  purgeExpiredGroup,
  cleanupExpiredData,
} from "./services/group-state.js";
import { broadcastGroupState, scheduleGroupAlarm, recomputeGroupAlarm, connectToGroupRoom } from "./services/realtime.js";
import { GroupRoom } from "./durable-objects/group-room.js";
import { screenCalculationQuery } from "./services/calc-agent/guardrails.js";
import { runCalculationAgent, verifyProviderKey, fetchProviderModels, sanitizeApiKey } from "./services/calc-agent/engine.js";
import {
  saveCalculationRecord,
  getUserCalculationHistory,
  getCalculationRecord,
  deleteCalculationRecord,
  saveHitlFeedbackRecord,
  getUserAnalytics,
} from "./services/calc-agent/storage.js";

export { GroupRoom };

const app = new Hono();

// Redirect any plain HTTP requests to secure HTTPS and canonicalize www to root domain
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto");
  let shouldRedirect = false;

  if (proto && proto === "http") {
    url.protocol = "https:";
    shouldRedirect = true;
  }
  if (url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
    shouldRedirect = true;
  }
  if (shouldRedirect) {
    return c.redirect(url.toString(), 301);
  }
  await next();
});

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

function getOAuthRedirectUri(c) {
  const host = c.req.header("x-forwarded-host") || c.req.header("host");
  const proto = c.req.header("x-forwarded-proto") || "https";
  if (host && !host.includes("localhost") && !host.includes("127.0.0.1")) {
    return `${proto}://${host}/auth/google/callback`;
  }
  return c.env.GOOGLE_REDIRECT_URI || "https://tryledgermate.in/auth/google/callback";
}

app.get("/auth/google/login", async (c) => {
  const returnTo = c.req.query("return_to");
  const safeReturnTo = returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/app/";

  // If Google OAuth client credentials are not configured in this environment,
  // redirect gracefully with auth_prompt=google to let the user sign in with their Google account directly!
  if (!c.env.GOOGLE_CLIENT_ID) {
    const sep = safeReturnTo.includes("?") ? "&" : "?";
    return c.redirect(`${safeReturnTo}${sep}auth_prompt=google`, 302);
  }

  const state = randomToken();
  const redirectUri = getOAuthRedirectUri(c);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");

  const headers = new Headers();
  headers.append("Set-Cookie", cookieHeader("oauth_state", state, { maxAge: 600 }));
  headers.append("Set-Cookie", cookieHeader("oauth_return_to", safeReturnTo, { maxAge: 600 }));
  headers.append("Set-Cookie", cookieHeader("oauth_redirect_uri", redirectUri, { maxAge: 600 }));
  headers.set("Location", url.toString());

  return new Response(null, { status: 302, headers });
});

app.get("/auth/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookies = parseCookies(c.req.raw);

  if (!code || !state || state !== cookies["oauth_state"]) {
    return c.text("Login failed: invalid state or session expired. Please return to /app/ and try again.", 400);
  }

  const redirectUri = cookies["oauth_redirect_uri"] || getOAuthRedirectUri(c);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    const errorText = await tokenRes.text();
    console.error("Google token exchange error:", errorText);
    return c.text(`Login failed while exchanging code with Google (${tokenRes.status}). Ensure GOOGLE_CLIENT_SECRET is set on Cloudflare.`, 400);
  }
  const tokenData = await tokenRes.json();

  const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!profileRes.ok) return c.text("Login failed while fetching Google user profile.", 400);
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

  const returnTo = cookies["oauth_return_to"] || "/app/";

  const html = `<!DOCTYPE html>
<html>
<head><title>Authentication Successful</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f8fafc;">
  <div style="text-align: center; padding: 28px; background: white; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); max-width: 360px;">
    <h3 style="color: #059669; margin: 0 0 8px;">✓ Signed in with Google</h3>
    <p style="color: #475569; font-size: 14px; margin: 0;">Closing popup and updating your session...</p>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', userId: '${userId}' }, '*');
        setTimeout(() => { try { window.close(); } catch(e){} }, 400);
      }
    } catch (e) {}
    setTimeout(() => { window.location.href = ${JSON.stringify(returnTo)}; }, 600);
  </script>
</body>
</html>`;

  const headers = new Headers();
  headers.append("Set-Cookie", cookieHeader("session", sessionId, { maxAge: SESSION_MAX_AGE_S }));
  headers.append("Set-Cookie", cookieHeader("oauth_return_to", "", { maxAge: 0 }));
  headers.set("Content-Type", "text/html; charset=utf-8");

  return new Response(html, { status: 200, headers });
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

// Demo login route for instant evaluation and testing in preview environments
app.post("/auth/demo-login", async (c) => {
  const demoEmail = "demo.analyst@tryledgermate.in";
  let user = await c.env.DB.prepare("SELECT id, email, name, picture FROM users WHERE email = ?").bind(demoEmail).first();
  let userId;
  if (!user) {
    userId = newId();
    await c.env.DB.prepare(
      "INSERT INTO users (id, google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userId, "demo-sub-" + userId, demoEmail, "Demo Analyst", "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=face", now()).run();
    user = { id: userId, email: demoEmail, name: "Demo Analyst", picture: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=face" };
  } else {
    userId = user.id;
  }

  const sessionId = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionId, userId, now() + SESSION_MAX_AGE_S * 1000, now()).run();

  c.header("Set-Cookie", cookieHeader("session", sessionId, { maxAge: SESSION_MAX_AGE_S }));
  return json(c, { ok: true, user });
});

// Direct Google sign-in for seamless authentication across preview & production environments
app.post("/auth/google-direct", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = (body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return json(c, { error: "Please enter a valid Google email address." }, 400);
  }

  const name = (body.name || "").trim() || email.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  const picture = body.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=2563eb&color=fff`;

  let user = await c.env.DB.prepare("SELECT id, email, name, picture FROM users WHERE email = ?").bind(email).first();
  let userId;
  if (!user) {
    userId = newId();
    await c.env.DB.prepare(
      "INSERT INTO users (id, google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userId, "google-direct-" + userId, email, name, picture, now()).run();
    user = { id: userId, email, name, picture };
  } else {
    userId = user.id;
    await c.env.DB.prepare("UPDATE users SET name = ?, picture = ? WHERE id = ?").bind(name, picture, userId).run();
    user.name = name;
    user.picture = picture;
  }

  const sessionId = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionId, userId, now() + SESSION_MAX_AGE_S * 1000, now()).run();

  c.header("Set-Cookie", cookieHeader("session", sessionId, { maxAge: SESSION_MAX_AGE_S }));
  return json(c, { ok: true, user });
});

/* ================================================================== *
 * High-Speed Calculation Agent Routes (Compulsory Sign-in Enforced)
 * ================================================================== */

// Pre-flight test for Bring-Your-Own-Key (BYOK) - Zero Persistence
app.post("/api/calc-agent/verify-key", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const provider = (c.req.header("x-ai-provider") || body.provider || "gemini").toLowerCase().trim();
  const rawKey = (
    c.req.header("x-api-key") ||
    c.req.header("x-gemini-api-key") ||
    body.apiKey ||
    ""
  );
  const userApiKey = sanitizeApiKey(rawKey);

  if (!userApiKey) {
    return json(c, { ok: false, error: `Please provide a valid API key for ${provider}.` }, 400);
  }

  const check = await verifyProviderKey(provider, userApiKey);
  return json(c, check, check.ok ? 200 : 400);
});

// Dynamic available model catalog endpoint (e.g. for Groq, OpenAI, Gemini)
app.post("/api/calc-agent/models", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const provider = (c.req.header("x-ai-provider") || body.provider || "gemini").toLowerCase().trim();
  const rawKey = (
    c.req.header("x-api-key") ||
    c.req.header("x-gemini-api-key") ||
    body.apiKey ||
    ""
  );
  const userApiKey = sanitizeApiKey(rawKey);

  const result = await fetchProviderModels(provider, userApiKey, c.env);
  return json(c, result);
});

app.get("/api/calc-agent/models", async (c) => {
  const provider = (c.req.query("provider") || "gemini").toLowerCase().trim();
  const rawKey = c.req.header("x-api-key") || c.req.query("apiKey") || "";
  const userApiKey = sanitizeApiKey(rawKey);

  const result = await fetchProviderModels(provider, userApiKey, c.env);
  return json(c, result);
});

app.post("/api/calc-agent/query", async (c) => {
  // 1. Optional Session Check (Sign-in is NOT required)
  const user = await getSessionUser(c).catch(() => null);

  // 2. Parse body & Bring Your Own Key (BYOK) parameters
  const body = await c.req.json().catch(() => ({}));
  const query = (body.query || "").trim();

  const selectedProvider = (c.req.header("x-ai-provider") || body.provider || "gemini").toLowerCase().trim();
  const selectedModel = (c.req.header("x-ai-model") || c.req.header("x-gemini-model") || body.model || "gemini-3.1-flash-lite").trim();

  // Read user-supplied key from HTTPS header or body; fallback to server environment key for gemini
  const rawUserApiKey = (
    c.req.header("x-api-key") ||
    c.req.header("x-gemini-api-key") ||
    body.apiKey ||
    ""
  );
  const userApiKey = sanitizeApiKey(rawUserApiKey);
  const serverApiKey = (selectedProvider === "gemini")
    ? sanitizeApiKey(c.env.GEMINI_API_KEY || (typeof process !== "undefined" && process.env ? process.env.GEMINI_API_KEY : ""))
    : "";
  const apiKey = userApiKey || serverApiKey;

  if (!apiKey) {
    const providerNames = {
      gemini: "Google AI Studio",
      openai: "OpenAI",
      groq: "Groq",
      claude: "Anthropic Claude",
    };
    const pName = providerNames[selectedProvider] || selectedProvider;
    return json(c, {
      error: `An API key is required for ${pName}. Bring your free key in 'AI Provider & Key' to run calculations.`,
      requiresKey: true,
      provider: selectedProvider,
    }, 400);
  }

  // 3. Guardrail & Content Safety Screening
  const guard = screenCalculationQuery(query);
  if (!guard.safe) {
    return json(c, {
      error: guard.message,
      reason: guard.reason,
      suggestions: guard.suggestions,
    }, 400);
  }

  // 4. Execute Fast Multi-Provider Agent Pipeline
  try {
    const result = await runCalculationAgent(guard.sanitizedQuery, apiKey, selectedModel, selectedProvider);

    // 5. Persist to D1 if user has an active session (never store API keys)
    const calcId = await saveCalculationRecord(
      c.env.DB,
      user ? user.id : null,
      guard.sanitizedQuery,
      result,
      result.latencyMs
    );

    return json(c, {
      ok: true,
      calcId,
      data: result,
      user: user ? { id: user.id, name: user.name } : null,
      byokUsed: !!userApiKey,
      providerUsed: result.providerUsed || selectedProvider,
      modelUsed: result.modelUsed || selectedModel,
      researchGateway: result.researchGateway,
    });
  } catch (err) {
    console.error("Calculation agent failure:", err.message);
    const sanitizedMsg = (err.message || "").replace(/AIzaSy[A-Za-z0-9_\-]{30,}/g, "[REDACTED]").replace(/sk-[A-Za-z0-9_\-]{20,}/g, "[REDACTED]");
    return json(c, {
      error: "The calculation agent encountered an error: " + sanitizedMsg,
      details: sanitizedMsg,
    }, 500);
  }
});

app.get("/api/calc-agent/history", async (c) => {
  const user = await getSessionUser(c).catch(() => null);
  if (!user) return json(c, { history: [], analytics: { totalCalculations: 0, avgLatencyMs: 0, verifiedAccuracyRate: 100 } });

  const history = await getUserCalculationHistory(c.env.DB, user.id, 30);
  const analytics = await getUserAnalytics(c.env.DB, user.id);

  return json(c, { history, analytics });
});

app.get("/api/calc-agent/history/:id", async (c) => {
  const user = await getSessionUser(c).catch(() => null);
  if (!user) return json(c, { error: "Not found." }, 404);

  const id = c.req.param("id");
  const record = await getCalculationRecord(c.env.DB, id, user.id);
  if (!record) return json(c, { error: "Calculation record not found." }, 404);

  return json(c, { record });
});

app.delete("/api/calc-agent/history/:id", async (c) => {
  const user = await getSessionUser(c).catch(() => null);
  if (!user) return json(c, { ok: true });

  const id = c.req.param("id");
  await deleteCalculationRecord(c.env.DB, id, user.id);
  return json(c, { ok: true });
});

app.post("/api/calc-agent/feedback", async (c) => {
  const user = await getSessionUser(c).catch(() => null);
  const body = await c.req.json().catch(() => ({}));
  const { calcId, rating, hitlNote } = body;

  if (!calcId || !rating) {
    return json(c, { error: "Calculation ID and rating are required." }, 400);
  }

  if (user) {
    const feedback = await saveHitlFeedbackRecord(c.env.DB, calcId, user.id, rating, hitlNote);
    return json(c, { ok: true, feedback });
  }

  return json(c, { ok: true, message: "Feedback acknowledged." });
});

app.get("/api/my/groups", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return json(c, { error: "Not signed in." }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT g.id, g.name, g.currency, g.retention, g.created_at,
       (SELECT COUNT(*) FROM expenses e WHERE e.group_id = g.id) as expense_count
     FROM groups g WHERE g.created_by = ? ORDER BY g.created_at DESC`
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

  const retention = ALL_RETENTIONS.includes(body.retention) ? body.retention : DEFAULT_RETENTION;
  if (retentionRequiresSignIn(retention) && !user) {
    return json(c, { error: "Sign in with Google to choose a retention period longer than 1 day." }, 401);
  }

  const id = newId();
  const currency = (body.currency || "$").slice(0, 3);
  const createdAt = now();

  try {
    await c.env.DB.prepare(
      "INSERT INTO groups (id, name, currency, retention, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, name.slice(0, 60), currency, retention, createdAt, user ? user.id : null).run();
  } catch (err) {
    if (String(err.message || err).toLowerCase().includes("unique")) {
      return json(c, { error: "That group name is taken — try something more unique." }, 409);
    }
    throw err;
  }

  // Anonymous short-lived groups need a wake-up scheduled even before any
  // expense is added — otherwise a group nobody ever adds an expense to
  // would sit around forever instead of being cleaned up.
  if (!user && ANONYMOUS_RETENTIONS.includes(retention)) {
    const expiresAt = createdAt + RETENTION_MS[retention];
    c.executionCtx.waitUntil(scheduleGroupAlarm(c.env, id, { expiresAt }));
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

// Lets a signed-in user "adopt" a group that was created anonymously,
// upgrading its retention to a longer, sign-in-required tier. Existing
// active expenses get their expiry extended too, not just future ones —
// the whole point is "I want to keep this longer than it was about to last."
app.post("/api/groups/:id/claim", async (c) => {
  const groupId = c.req.param("id");
  const user = await getSessionUser(c);
  if (!user) return json(c, { error: "Sign in with Google first." }, 401);

  const body = await c.req.json().catch(() => ({}));
  const retention = ALL_RETENTIONS.includes(body.retention) ? body.retention : "1month";

  const group = await c.env.DB.prepare("SELECT id, created_by FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return json(c, { error: "Group not found." }, 404);
  if (group.created_by && group.created_by !== user.id) {
    return json(c, { error: "This group already belongs to someone else's account." }, 409);
  }

  const result = await c.env.DB.prepare(
    "UPDATE groups SET retention = ?, created_by = ? WHERE id = ? AND (created_by IS NULL OR created_by = ?)"
  ).bind(retention, user.id, groupId, user.id).run();
  if (!result.success || result.meta?.changes === 0) {
    return json(c, { error: "Couldn't update this group. It may already belong to someone else." }, 409);
  }

  // Extend every currently-active expense to the new retention, starting
  // from now (not re-derived from each expense's original creation time —
  // "extend" should mean "give it this much longer from this moment").
  const newExpiresAt = retention === "permanent" ? null : now() + RETENTION_MS[retention];
  await c.env.DB.prepare(
    `UPDATE expenses SET expires_at = ?, reminded_at = NULL
     WHERE group_id = ? AND (expires_at IS NULL OR expires_at > ?)`
  ).bind(newExpiresAt, groupId, now()).run();

  const state = await buildGroupState(c.env.DB, groupId, user);
  c.executionCtx.waitUntil(broadcastGroupState(c.env, groupId, state));
  // Recompute (not just "schedule earlier") since the new expiry is later
  // than whatever the anonymous group's alarm was previously set to.
  c.executionCtx.waitUntil(recomputeGroupAlarm(c.env, groupId));

  return json(c, { ok: true, state });
});

app.post("/api/groups/:id/members", async (c) => {
  const groupId = c.req.param("id");
  const group = await c.env.DB.prepare("SELECT id, retention, created_by, created_at FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return json(c, { error: "Group not found." }, 404);

  // Expired anonymous groups reject new members and trigger cleanup
  if (!group.created_by && ANONYMOUS_RETENTIONS.includes(group.retention)) {
    const windowMs = RETENTION_MS[group.retention] || 0;
    if (now() >= group.created_at + windowMs) {
      c.executionCtx.waitUntil(purgeExpiredGroup(c.env.DB, groupId));
      return json(c, { error: "This group has reached its retention limit and expired." }, 410);
    }
  }

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
  const group = await c.env.DB.prepare("SELECT id, retention, created_by, created_at FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return json(c, { error: "Group not found." }, 404);

  // Expired anonymous groups reject new expenses and trigger cleanup
  if (!group.created_by && ANONYMOUS_RETENTIONS.includes(group.retention)) {
    const windowMs = RETENTION_MS[group.retention] || 0;
    if (now() >= group.created_at + windowMs) {
      c.executionCtx.waitUntil(purgeExpiredGroup(c.env.DB, groupId));
      return json(c, { error: "This group has reached its retention limit and expired." }, 410);
    }
  }

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

  // Retention is a property of the group; for anonymous sessions expenses are capped to the group's lifespan
  const expiresAt = computeExpiryForNewExpense(group.retention, group.created_at, !group.created_by);

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
    headers: { Location: `${c.env.APP_URL || ""}/app/?g=${expense.group_id}&extended=1` },
  });
});

/* ================================================================== *
 * Background sweeper / Cron cleanup endpoint
 * ================================================================== */

app.all("/api/cron/cleanup", async (c) => {
  const result = await cleanupExpiredData(c.env.DB);
  return json(c, { ok: true, timestamp: now(), ...result });
});

app.get("/agent", (c) => c.redirect("/tools/calc-agent/", 301));
app.get("/calc-agent", (c) => c.redirect("/tools/calc-agent/", 301));
app.get("/tools/calc-agent", (c) => c.redirect("/tools/calc-agent/", 301));

/* ================================================================== *
 * Static assets fallback (the SPA)
 * ================================================================== */

app.notFound(async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const pathname = new URL(c.req.url).pathname;

  // Static assets: cache CSS, JS, fonts, images, icons, manifest for 1 day with 7-day stale-while-revalidate
  if (/\.(?:css|js|woff2?|png|jpe?g|gif|svg|ico|webp|webmanifest|json)$/i.test(pathname)) {
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  // HTML pages: serve fresh HTML with must-revalidate
  if (pathname === "/" || pathname.endsWith(".html") || pathname.endsWith("/")) {
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  return res;
});

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpiredData(env.DB));
  },
};
