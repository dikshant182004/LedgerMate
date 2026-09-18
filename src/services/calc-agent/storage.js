/**
 * Storage & Analytics Service for Calculation Agent
 * Single Responsibility: Manages D1 database persistence for user calculation history,
 * HITL (Human-in-the-Loop) feedback, and aggregate performance analytics.
 */

import { now, newId } from "../../lib/crypto.js";

let tablesInitialized = false;

export async function ensureCalcTables(db) {
  if (tablesInitialized) return;
  try {
    await db.batch([
      db.prepare(`
        CREATE TABLE IF NOT EXISTS calc_history (
          id              TEXT PRIMARY KEY,
          user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          query           TEXT NOT NULL,
          category        TEXT NOT NULL,
          headline_result TEXT NOT NULL,
          data_json       TEXT NOT NULL,
          latency_ms      INTEGER NOT NULL,
          created_at      INTEGER NOT NULL
        )
      `),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_calc_history_user ON calc_history(user_id, created_at DESC)`),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS calc_feedback (
          id              TEXT PRIMARY KEY,
          calc_id         TEXT NOT NULL REFERENCES calc_history(id) ON DELETE CASCADE,
          user_id         TEXT NOT NULL REFERENCES users(id),
          rating          TEXT NOT NULL,
          hitl_note       TEXT,
          status          TEXT NOT NULL DEFAULT 'submitted',
          created_at      INTEGER NOT NULL
        )
      `),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_calc_feedback_calc ON calc_feedback(calc_id)`),
    ]);
    tablesInitialized = true;
  } catch (err) {
    console.warn("Could not ensure calc tables (may already exist):", err.message);
  }
}

export async function saveCalculationRecord(db, userId, query, resultData, latencyMs) {
  const id = newId();
  if (!userId || !db) return id;

  try {
    await ensureCalcTables(db);
    const timestamp = now();

    await db.prepare(`
      INSERT INTO calc_history (id, user_id, query, category, headline_result, data_json, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      userId,
      query.slice(0, 500),
      resultData.category || "General Math",
      resultData.headlineResult || String(resultData.primaryValue || ""),
      JSON.stringify(resultData),
      latencyMs,
      timestamp
    ).run();
  } catch (err) {
    console.warn("Could not persist calculation history record:", err.message);
  }

  return id;
}

export async function getUserCalculationHistory(db, userId, limit = 20) {
  await ensureCalcTables(db);
  const { results } = await db.prepare(`
    SELECT id, query, category, headline_result, latency_ms, created_at
    FROM calc_history
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(userId, limit).all();

  return results || [];
}

export async function getCalculationRecord(db, calcId, userId) {
  await ensureCalcTables(db);
  const row = await db.prepare(`
    SELECT id, user_id, query, category, headline_result, data_json, latency_ms, created_at
    FROM calc_history
    WHERE id = ? AND user_id = ?
  `).bind(calcId, userId).first();

  if (!row) return null;
  return {
    ...row,
    data: JSON.parse(row.data_json),
  };
}

export async function deleteCalculationRecord(db, calcId, userId) {
  await ensureCalcTables(db);
  await db.prepare(`
    DELETE FROM calc_history WHERE id = ? AND user_id = ?
  `).bind(calcId, userId).run();
  return true;
}

export async function saveHitlFeedbackRecord(db, calcId, userId, rating, hitlNote) {
  await ensureCalcTables(db);
  const id = newId();
  await db.prepare(`
    INSERT INTO calc_feedback (id, calc_id, user_id, rating, hitl_note, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'submitted', ?)
  `).bind(
    id,
    calcId,
    userId,
    rating,
    hitlNote ? hitlNote.slice(0, 1000) : null,
    now()
  ).run();

  return { id, status: "submitted" };
}

export async function getUserAnalytics(db, userId) {
  await ensureCalcTables(db);
  const totalRow = await db.prepare(`
    SELECT COUNT(*) as total_count, AVG(latency_ms) as avg_latency
    FROM calc_history
    WHERE user_id = ?
  `).bind(userId).first();

  const { results: categoryCounts } = await db.prepare(`
    SELECT category, COUNT(*) as count
    FROM calc_history
    WHERE user_id = ?
    GROUP BY category
    ORDER BY count DESC
  `).bind(userId).all();

  return {
    totalCalculations: totalRow?.total_count || 0,
    avgLatencyMs: Math.round(totalRow?.avg_latency || 0),
    categories: categoryCounts || [],
  };
}
