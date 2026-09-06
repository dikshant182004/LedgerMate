export const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = { day: 1, week: 7, twoweek: 14, month: 30 };
export const REMINDER_WINDOW_MS = 2 * DAY_MS; // send reminder when <=48h from expiry

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

  return { group, members, expenses, balances, settlements, currentUser: user };
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
  return Date.now() + (RETENTION_DAYS[retention] || RETENTION_DAYS.month) * DAY_MS;
}

/**
 * Given a group's id, finds the earliest upcoming "event" that its DO alarm
 * should wake up for: either a not-yet-sent 48h expiry reminder, or an
 * expense's actual deletion time. Returns null if the group has nothing
 * pending (e.g. no expenses, or all expenses are permanent).
 */
export async function findNextAlarmTime(DB, groupId) {
  const reminderRow = await DB.prepare(
    `SELECT MIN(expires_at) as t FROM expenses
     WHERE group_id = ? AND expires_at IS NOT NULL AND reminded_at IS NULL`
  ).bind(groupId).first();
  const expiryRow = await DB.prepare(
    `SELECT MIN(expires_at) as t FROM expenses WHERE group_id = ? AND expires_at IS NOT NULL`
  ).bind(groupId).first();

  const candidates = [];
  if (reminderRow?.t) candidates.push(reminderRow.t - REMINDER_WINDOW_MS);
  if (expiryRow?.t) candidates.push(expiryRow.t);
  if (candidates.length === 0) return null;

  // Never schedule into the past — a reminder time that's already gone by
  // (e.g. an expense created with < 48h left on its retention) should fire
  // almost immediately, not be skipped.
  return Math.max(Date.now() + 1000, Math.min(...candidates));
}
