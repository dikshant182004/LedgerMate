export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// Retention tiers. Anyone can use ANONYMOUS_RETENTIONS without signing in —
// meant for "split it, settle up, done" quick sessions. Anything longer
// requires a signed-in account (Google sign-in itself provides the email —
// no separate field needed), because it ties the group to that account
// instead of leaving it to expire on its own.
export const RETENTION_MS = {
  "10min": 10 * MINUTE_MS,
  "1hour": 1 * HOUR_MS,
  "1day": 1 * DAY_MS,
  "1week": 7 * DAY_MS,
  "1month": 30 * DAY_MS,
  "6month": 182 * DAY_MS,
  "1year": 365 * DAY_MS,
};
export const ANONYMOUS_RETENTIONS = ["10min", "1hour", "1day"];
export const SIGNIN_RETENTIONS = ["1week", "1month", "6month", "1year", "permanent"];
export const ALL_RETENTIONS = [...ANONYMOUS_RETENTIONS, ...SIGNIN_RETENTIONS];
export const DEFAULT_RETENTION = "1day";

export function retentionRequiresSignIn(retention) {
  return SIGNIN_RETENTIONS.includes(retention);
}

export const REMINDER_WINDOW_MS = 2 * DAY_MS; // send reminder when <=48h from expiry
// Below this, a 48h-ahead reminder wouldn't make sense (it'd fire after the
// thing already expired) — reminders are skipped for these regardless of
// sign-in state, since they're meant to be quick, ephemeral sessions anyway.
export const REMINDER_ELIGIBLE_RETENTIONS = ["1week", "1month", "6month", "1year"];

/**
 * Builds the full { group, members, expenses, balances, settlements } payload
 * for a group. This is the one place that assembles group state, so every
 * caller — the initial GET, a mutation's response, a realtime broadcast, an
 * alarm-triggered cleanup — sees an identical shape.
 *
 * `user` is the *viewer's* session user (or null), attached as `currentUser`.
 * It is per-viewer, not per-group, so it must never be forwarded into a
 * realtime broadcast payload — see stripForBroadcast().
 */
export async function buildGroupState(DB, groupId, user) {
  const group = await DB.prepare("SELECT * FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return null;

  const { results: members } = await DB.prepare(
    "SELECT id, name FROM members WHERE group_id = ? ORDER BY created_at ASC"
  ).bind(groupId).all();

  const { results: expenses } = await DB.prepare(
    `SELECT id, description, amount, paid_by, created_at, expires_at
     FROM expenses
     WHERE group_id = ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC`
  ).bind(groupId, Date.now()).all();

  const { results: splits } = await DB.prepare(
    `SELECT es.expense_id, es.member_id, es.share_amount
     FROM expense_splits es
     JOIN expenses e ON e.id = es.expense_id
     WHERE e.group_id = ? AND (e.expires_at IS NULL OR e.expires_at > ?)`
  ).bind(groupId, Date.now()).all();

  const { balances, settlements } = computeBalances(members, expenses, splits);

  const splitsByExpense = new Map();
  for (const s of splits) {
    if (!splitsByExpense.has(s.expense_id)) splitsByExpense.set(s.expense_id, []);
    splitsByExpense.get(s.expense_id).push({
      member_id: s.member_id,
      amount: s.share_amount,
    });
  }

  const enrichedExpenses = expenses.map((e) => ({
    ...e,
    splits: splitsByExpense.get(e.id) || [],
  }));

  return { group, members, expenses: enrichedExpenses, balances, settlements, currentUser: user };
}

// Realtime broadcasts go to every open tab in a group, from any viewer's
// session — currentUser must not leak from whoever's mutation triggered it.
export function stripForBroadcast(state) {
  const { currentUser, ...rest } = state;
  return rest;
}

export function computeBalances(members, expenses, splits) {
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

export function simplifyDebts(balances) {
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

/**
 * Given a group's chosen retention policy, computes when a *newly created*
 * expense should expire. 'permanent' groups never expire their expenses.
 */
export function computeExpiryForNewExpense(retention) {
  if (retention === "permanent") return null;
  return Date.now() + (RETENTION_MS[retention] || RETENTION_MS[DEFAULT_RETENTION]);
}

/**
 * Given a group's id, finds the earliest upcoming "event" that its DO alarm
 * should wake up for: either a not-yet-sent 48h expiry reminder, or an
 * expense's actual deletion time, or (for anonymous short-lived groups) the
 * group's own cleanup check. Returns null if nothing is pending.
 */
export async function findNextAlarmTime(DB, groupId) {
  const group = await DB.prepare("SELECT retention, created_by, created_at FROM groups WHERE id = ?").bind(groupId).first();
  if (!group) return null;

  const reminderEligible = REMINDER_ELIGIBLE_RETENTIONS.includes(group.retention);
  const reminderRow = reminderEligible
    ? await DB.prepare(
        `SELECT MIN(expires_at) as t FROM expenses
         WHERE group_id = ? AND expires_at IS NOT NULL AND reminded_at IS NULL AND created_by IS NOT NULL`
      ).bind(groupId).first()
    : null;
  const expiryRow = await DB.prepare(
    `SELECT MIN(expires_at) as t FROM expenses WHERE group_id = ? AND expires_at IS NOT NULL`
  ).bind(groupId).first();

  const candidates = [];
  if (reminderRow?.t) candidates.push(reminderRow.t - REMINDER_WINDOW_MS);
  if (expiryRow?.t) candidates.push(expiryRow.t);

  // Anonymous, short-lived groups get a fallback wake-up at the end of their
  // own window even if no expense was ever added — otherwise an abandoned
  // empty group with no expenses would never get an alarm scheduled at all,
  // and would sit around forever instead of being cleaned up.
  if (!group.created_by && ANONYMOUS_RETENTIONS.includes(group.retention)) {
    candidates.push(group.created_at + RETENTION_MS[group.retention]);
  }

  if (candidates.length === 0) return null;

  // Never schedule into the past — a time that's already gone by (e.g. an
  // expense created with < 48h left on its retention) should fire almost
  // immediately, not be skipped.
  return Math.max(Date.now() + 1000, Math.min(...candidates));
}