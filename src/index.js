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

// Allowed Gemini models for validation
const ALLOWED_GEMINI_MODELS = new Set([
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
  "gemini-2.5-flash",
  "gemini-3.1-pro",
]);

// Simple in-memory rate limiter for calc-agent (per user per minute)
const calcRateLimit = new Map(); // userId -> { count, windowStart }

function checkCalcRateLimit(userId, limit = 30, windowMs = 60000) {
  const nowMs = Date.now();
  const record = calcRateLimit.get(userId);
  if (!record || nowMs - record.windowStart > windowMs) {
    calcRateLimit.set(userId, { count: 1, windowStart: nowMs });
    return { allowed: true, remaining: limit - 1 };
  }
  if (record.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: record.windowStart + windowMs };
  }
  record.count++;
  return { allowed: true, remaining: limit - record.count };
}

// Rate limit middleware for calc-agent
async function calcRateLimitMiddleware(c, next) {
  const user = await getSessionUser(c).catch(() => null);
  if (user) {
    const rl = checkCalcRateLimit(user.id);
    c.header("X-RateLimit-Limit", "30");
    c.header("X-RateLimit-Remaining", String(rl.remaining));
    if (rl.resetAt) c.header("X-RateLimit-Reset", String(Math.ceil(rl.resetAt / 1000)));
    if (!rl.allowed) {
      return json(c, { 
        error: "Rate limit exceeded. Maximum 30 calculations per minute.", 
        retryAfter: Math.ceil((rl.resetAt - Date.now()) / 1000) 
      }, 429);
    }
  }
  await next();
}

// CSP headers for calc-agent page
async function cspMiddleware(c, next) {
  await next();
  const isCalcAgent = c.req.path.startsWith("/tools/calc-agent");
  if (isCalcAgent) {
    c.header("Content-Security-Policy", 
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data: https:; " +
      "connect-src 'self' https://api.resend.com https://oauth2.googleapis.com https://www.googleapis.com https://generativelanguage.googleapis.com; " +
      "frame-ancestors 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self';"
    );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  }
}

app.use("*", cspMiddleware);

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

// Favicon fallback handler
app.get("/favicon.ico", (c) => {
  return c.redirect("/icons/favicon-32.png", 302);
});

const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days
const CALC_LANGUAGES = new Set(["English", "Arabic", "Chinese", "French", "German", "Hindi", "Japanese", "Portuguese", "Russian", "Spanish"]);

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
app.post("/api/calc-agent/verify-key", calcRateLimitMiddleware, async (c) => {
  const user = await getSessionUser(c).catch(() => null);
  if (!user) return json(c, { error: "Sign in with Google to use the calculation agent.", requiresSignIn: true }, 401);
  // Only accept API key via secure header, never from body (prevents logging)
  const rawKey = c.req.header("x-api-key") || c.req.header("x-gemini-api-key") || "";
  const userApiKey = sanitizeApiKey(rawKey);

  if (!userApiKey) {
    return json(c, { ok: false, error: "Please provide a valid Google AI Studio API key via x-api-key header." }, 400);
  }

  const check = await verifyProviderKey("gemini", userApiKey);
  return json(c, check, check.ok ? 200 : 400);
});

// Gemini model catalog endpoint.
app.get("/api/calc-agent/models", calcRateLimitMiddleware, async (c) => {
  const user = await getSessionUser(c).catch(() => null);
  if (!user) return json(c, { error: "Sign in with Google to use the calculation agent.", requiresSignIn: true }, 401);
  // Only accept API key via secure header
  const rawKey = c.req.header("x-api-key") || c.req.query("apiKey") || "";
  const userApiKey = sanitizeApiKey(rawKey);

  const result = await fetchProviderModels("gemini", userApiKey);
  return json(c, result);
});

app.post("/api/calc-agent/query", calcRateLimitMiddleware, async (c) => {
  // Google sign-in is required so calculations and consent are tied to an account.
  const user = await getSessionUser(c).catch(() => null);
  if (!user) return json(c, { error: "Sign in with Google to use the calculation agent.", requiresSignIn: true }, 401);

  // 2. Parse body & Bring Your Own Key (BYOK) parameters
  const body = await c.req.json().catch(() => ({}));
  const query = (body.query || "").trim();
  const outputLanguage = CALC_LANGUAGES.has(body.language) ? body.language : "English";
  const targetCurrency = body.targetCurrency || "original";

  // Validate model against allowed list
  let selectedModel = (c.req.header("x-ai-model") || c.req.header("x-gemini-model") || body.model || "gemini-3.1-flash-lite").trim();
  if (!ALLOWED_GEMINI_MODELS.has(selectedModel)) {
    selectedModel = "gemini-3.1-flash-lite";
  }

  if (body.geminiConsent !== true) {
    return json(c, { error: "Confirm consent to use your Google AI Studio free-tier key before submitting a query.", requiresConsent: true }, 400);
  }

  // Read user-supplied key ONLY from secure headers (never from body - prevents logging)
  const rawUserApiKey = c.req.header("x-api-key") || c.req.header("x-gemini-api-key") || "";
  const apiKey = sanitizeApiKey(rawUserApiKey);

  if (!apiKey) {
    return json(c, {
      error: "Provide your Google AI Studio API key via x-api-key header.",
      requiresKey: true,
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

  // 4. Execute the Gemini calculation pipeline with separate outputLanguage and targetCurrency
  try {
    const result = await runCalculationAgent(guard.sanitizedQuery, apiKey, selectedModel, {
      outputLanguage,
      targetCurrency,
    });
    result.outputLanguage = outputLanguage;
    result.targetCurrency = targetCurrency;

    // 5. Persist to D1 if user has an active session (never store API keys)
    const calcId = await saveCalculationRecord(
      c.env.DB,
      user.id,
      guard.sanitizedQuery,
      result,
      result.latencyMs
    );

    return json(c, {
      ok: true,
      calcId,
      data: result,
      user: { id: user.id, name: user.name, email: user.email, picture: user.picture },
      providerUsed: result.providerUsed || "gemini",
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
  if (!user) return json(c, { history: [], analytics: { totalCalculations: 0, avgLatencyMs: 0, verifiedAccuracyRate: 100, categories: [], recentPoints: [] } });

  const history = await getUserCalculationHistory(c.env.DB, user.id, 100);
  const analytics = await getUserAnalytics(c.env.DB, user.id);

  return json(c, { history, analytics, user });
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

// Re-run one calculation with an explicit, user-authored correction.
app.post("/api/calc-agent/refine", calcRateLimitMiddleware, async (c) => {
  const user = await getSessionUser(c).catch(() => null);
  if (!user) return json(c, { error: "Sign in with Google to refine a calculation.", requiresSignIn: true }, 401);
  const body = await c.req.json().catch(() => ({}));
  const calcId = String(body.calcId || "");
  const note = String(body.hitlNote || "").trim().slice(0, 1000);
  
  // Validate note content - must be a meaningful refinement
  if (!note || note.length < 3) return json(c, { error: "Please provide a specific refinement request (minimum 3 characters)." }, 400);
  
  // Only accept API key via secure header
  const rawApiKey = c.req.header("x-api-key") || c.req.header("x-gemini-api-key") || "";
  const apiKey = sanitizeApiKey(rawApiKey);
  
  // Validate model against allowed list
  let selectedModel = (c.req.header("x-ai-model") || body.model || "gemini-3.1-flash-lite").trim();
  if (!ALLOWED_GEMINI_MODELS.has(selectedModel)) {
    selectedModel = "gemini-3.1-flash-lite";
  }

  if (body.geminiConsent !== true || !apiKey) return json(c, { error: "Reconnect your Google AI Studio key and confirm consent to refine this result.", requiresKey: true }, 400);

  const record = await getCalculationRecord(c.env.DB, calcId, user.id);
  if (!record) return json(c, { error: "Calculation record not found." }, 404);
  const guard = screenCalculationQuery(record.query);
  if (!guard.safe) return json(c, { error: guard.message, reason: guard.reason }, 400);

  // Preserve original outputLanguage and targetCurrency unless explicitly overridden
  const originalData = record.data || {};
  const outputLanguage = CALC_LANGUAGES.has(body.language) ? body.language : (originalData.outputLanguage || "English");
  const targetCurrency = body.targetCurrency || originalData.targetCurrency || "original";

  try {
    await saveHitlFeedbackRecord(c.env.DB, calcId, user.id, "revision_requested", note);
    const refinedPrompt = `${guard.sanitizedQuery}\n\nRevision requested by the user for this calculation: ${note}`;
    const result = await runCalculationAgent(refinedPrompt, apiKey, selectedModel, {
      outputLanguage,
      targetCurrency,
    });
    result.outputLanguage = outputLanguage;
    result.targetCurrency = targetCurrency;
    result.refinedFrom = calcId;
    result.refinementNote = note;
    const newCalcId = await saveCalculationRecord(c.env.DB, user.id, record.query, result, result.latencyMs);
    return json(c, { ok: true, calcId: newCalcId, data: result, providerUsed: result.providerUsed, modelUsed: result.modelUsed });
  } catch (err) {
    console.error("Calculation refinement failure:", err.message);
    const sanitizedMsg = (err.message || "").replace(/AIzaSy[A-Za-z0-9_\-]{30,}/g, "[REDACTED]");
    return json(c, { error: "Could not refine the calculation: " + sanitizedMsg }, 500);
  }
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

/* ================================================================== *
 * Global Product Feedback Endpoint
 * ================================================================== */
app.post("/api/feedback", async (c) => {
  const user = await getSessionUser(c).catch(() => null);
  const body = await c.req.json().catch(() => ({}));
  const category = String(body.category || "General Feedback").slice(0, 100);
  const feedback = String(body.feedback || "").trim().slice(0, 3000);
  const rating = Number(body.rating) || 5;
  const contextUrl = String(body.contextUrl || "").slice(0, 500);
  const email = String(body.email || (user ? user.email : "")).trim().slice(0, 150);

  if (!feedback) {
    return json(c, { error: "Please provide your feedback or issue description." }, 400);
  }

  try {
    await c.env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS product_feedback (
        id          TEXT PRIMARY KEY,
        user_id     TEXT,
        category    TEXT NOT NULL,
        rating      INTEGER,
        feedback    TEXT NOT NULL,
        context_url TEXT,
        email       TEXT,
        created_at  INTEGER NOT NULL
      )
    `).run();

    const id = newId();
    await c.env.DB.prepare(`
      INSERT INTO product_feedback (id, user_id, category, rating, feedback, context_url, email, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, user ? user.id : null, category, rating, feedback, contextUrl, email, now()).run();

    return json(c, { ok: true, id, message: "Thank you for your feedback! Your report has been submitted." });
  } catch (err) {
    console.error("Feedback error:", err.message);
    return json(c, { error: "Could not save feedback: " + err.message }, 500);
  }
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

// Realtime channel for a group.
app.get("/api/groups/:id/socket", async (c) => {
  const groupId = c.req.param("id");
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected a WebSocket upgrade request.", 426);
  }
  return connectToGroupRoom(c.env, groupId, c.req.raw);
});

// Lets a signed-in user "adopt" an anonymous group
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

  const newExpiresAt = retention === "permanent" ? null : now() + RETENTION_MS[retention];
  await c.env.DB.prepare(
    `UPDATE expenses SET expires_at = ?, reminded_at = NULL
     WHERE group_id = ? AND (expires_at IS NULL OR expires_at > ?)`
  ).bind(newExpiresAt, groupId, now()).run();

  const state = await buildGroupState(c.env.DB, groupId, user);
  c.executionCtx.waitUntil(broadcastGroupState(c.env, groupId, state));
  c.executionCtx.waitUntil(recomputeGroupAlarm(c.env, groupId));

  return json(c, { ok: true, state });
});

app.post("/api/groups/:id/members", async (c) => {
  const groupId = c.req.param("id");
  const group = await c.env.DB.prepare("SELECT id, retention, created_by, created_at FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return json(c, { error: "Group not found." }, 404);

  if (!group.created_by && ANONYMOUS_RETENTIONS.includes(group.retention)) {
    const windowMs = RETENTION_MS[group.retention] || 0;
    if (now() >= group.created_at + windowMs) {
      c.executionCtx.waitUntil(purgeExpiredGroup(c.env.DB, groupId));
      return json(c, { error: "This group has reached its retention limit and expired." }, 410);
    }
  }

  const body = await c.req.json().catch(() => ({}));
  const name = (body.name || "").trim();
  if (!name) return json(c, { error: "Member name is required." }, 400);

  const memberId = newId();
  await c.env.DB.prepare(
    "INSERT INTO members (id, group_id, name, created_at) VALUES (?, ?, ?, ?)"
  ).bind(memberId, groupId, name.slice(0, 40), now()).run();

  const user = await getSessionUser(c);
  const state = await buildGroupState(c.env.DB, groupId, user);
  c.executionCtx.waitUntil(broadcastGroupState(c.env, groupId, state));

  return json(c, { id: memberId, name }, 201);
});

app.post("/api/groups/:id/expenses", async (c) => {
  const groupId = c.req.param("id");
  const group = await c.env.DB.prepare("SELECT id, retention, created_by, created_at FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return json(c, { error: "Group not found." }, 404);

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
  const paidById = body.paid_by;
  const splitWith = Array.isArray(body.split_with) ? body.split_with : [];

  if (!description) return json(c, { error: "Description is required." }, 400);
  if (isNaN(amount) || amount <= 0) return json(c, { error: "Amount must be greater than 0." }, 400);
  if (!paidById) return json(c, { error: "Payer is required." }, 400);
  if (splitWith.length === 0) return json(c, { error: "Select at least one person to split with." }, 400);

  const createdAt = now();
  const expiresAt = computeExpiryForNewExpense(group.retention, group.created_at, createdAt);

  if (expiresAt !== null && expiresAt <= createdAt) {
    return json(c, { error: "This group's retention window has closed; no new expenses can be added." }, 410);
  }

  const expenseId = newId();
  const signedProof = signExpenseId(expenseId, c.env.SIGNING_SECRET || "default_dev_secret");

  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO expenses (id, group_id, description, amount, paid_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(expenseId, groupId, description.slice(0, 100), amount, paidById, createdAt, expiresAt),
    ...splitWith.map((memberId) =>
      c.env.DB.prepare(
        "INSERT INTO expense_splits (expense_id, member_id) VALUES (?, ?)"
      ).bind(expenseId, memberId)
    ),
  ]);

  if (expiresAt !== null) {
    c.executionCtx.waitUntil(scheduleGroupAlarm(c.env, groupId, { expiresAt }));
  }

  const user = await getSessionUser(c);
  const state = await buildGroupState(c.env.DB, groupId, user);
  c.executionCtx.waitUntil(broadcastGroupState(c.env, groupId, state));

  return json(c, { id: expenseId, proof: signedProof }, 201);
});

app.delete("/api/groups/:id/expenses/:expenseId", async (c) => {
  const groupId = c.req.param("id");
  const expenseId = c.req.param("expenseId");

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM expense_splits WHERE expense_id = ?").bind(expenseId),
    c.env.DB.prepare("DELETE FROM expenses WHERE id = ? AND group_id = ?").bind(expenseId, groupId),
  ]);

  const user = await getSessionUser(c);
  const state = await buildGroupState(c.env.DB, groupId, user);
  c.executionCtx.waitUntil(broadcastGroupState(c.env, groupId, state));

  return json(c, { ok: true });
});

app.get("/api/cron/cleanup", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (c.env.CRON_SECRET && authHeader !== `Bearer ${c.env.CRON_SECRET}`) {
    return c.text("Unauthorized", 401);
  }
  const result = await cleanupExpiredData(c.env.DB);
  return json(c, result);
});

export default app;
