import {
  buildGroupState,
  findNextAlarmTime,
  stripForBroadcast,
  REMINDER_WINDOW_MS,
  ANONYMOUS_RETENTIONS,
  RETENTION_MS,
} from "../services/group-state.js";
import { sendReminderEmail } from "../lib/email.js";

/**
 * GroupRoom — one Durable Object instance per group (addressed via
 * env.GROUP_ROOM.idFromName(groupId)).
 *
 * Responsibilities (and *only* these — validation, splitting math, and
 * session/auth all stay in the Worker's HTTP routes):
 *
 *  1. Realtime fan-out: holds the group's live WebSocket connections and
 *     pushes fresh state to all of them whenever the Worker tells it
 *     something changed. Uses the Hibernatable WebSockets API
 *     (`state.acceptWebSocket`) so an open-but-idle tab does not keep this
 *     DO pinned in memory or billing compute time — the runtime can evict
 *     it and wake it back up (including for `alarm()`) as needed. This is
 *     what keeps "many groups, each with a few idle viewers" cheap at scale
 *     instead of requiring one warm process per open tab.
 *
 *  2. That group's own expiry/reminder schedule, via the Alarms API. Instead
 *     of a single global cron job scanning every expense in the database
 *     once a day (a scan that gets slower as the whole app grows), each
 *     group's DO sets exactly one alarm for its own next-soonest event
 *     (a 48h-before reminder email, or an actual deletion) and only wakes up
 *     when there's real work to do for *that* group. This is O(groups with
 *     something pending) instead of O(all expenses, every day).
 */
export class GroupRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.groupId = null;
    // Durable Object constructors can't be async, so loading persisted state
    // (the groupId this instance belongs to) happens inside
    // blockConcurrencyWhile — the runtime queues any incoming request until
    // this finishes, so we never handle a request before groupId is loaded.
    this.state.blockConcurrencyWhile(async () => {
      this.groupId = (await this.state.storage.get("groupId")) ?? null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.#handleSocketUpgrade(request, url);
    }
    if (url.pathname === "/broadcast" && request.method === "POST") {
      return this.#handleBroadcast(request, url);
    }
    if (url.pathname === "/schedule" && request.method === "POST") {
      return this.#handleSchedule(request, url);
    }
    if (url.pathname === "/recompute" && request.method === "POST") {
      return this.#handleRecompute(request, url);
    }
    return new Response("Not found", { status: 404 });
  }

  // --- WebSocket lifecycle (Hibernatable WebSockets API) -------------------

  async webSocketMessage(_ws, _message) {
    // One-way push channel today — clients don't send anything meaningful.
    // Reserved here (rather than left unimplemented) so a future heartbeat
    // or typing-indicator feature has an obvious place to land.
  }

  async webSocketClose(_ws, _code, _reason, _wasClean) {
    // Nothing to do — the Hibernatable WebSockets API already removes the
    // socket from state.getWebSockets() once it's closed.
  }

  async webSocketError(_ws, _error) {
    // Hibernation API cleans up the socket on our behalf; nothing to do.
  }

  // --- Alarm: this group's own expiry + reminder schedule -------------------

  async alarm() {
    if (!this.groupId) return;
    const db = this.env.DB;
    const nowTs = Date.now();

    const { results: dueForReminder } = await db.prepare(
      `SELECT e.id, e.description, e.amount, e.expires_at, e.group_id, u.email as user_email
       FROM expenses e
       JOIN users u ON u.id = e.created_by
       WHERE e.group_id = ? AND e.expires_at IS NOT NULL
         AND e.expires_at > ? AND e.expires_at <= ? AND e.reminded_at IS NULL`
    ).bind(this.groupId, nowTs, nowTs + REMINDER_WINDOW_MS).all();

    if (dueForReminder.length > 0) {
      const group = await db.prepare("SELECT id, name, currency FROM groups WHERE id = ?").bind(this.groupId).first();
      for (const exp of dueForReminder) {
        if (group && exp.user_email) await sendReminderEmail(this.env, exp, group, exp.user_email);
        await db.prepare("UPDATE expenses SET reminded_at = ? WHERE id = ?").bind(nowTs, exp.id).run();
      }
    }

    const { results: expired } = await db.prepare(
      "SELECT id FROM expenses WHERE group_id = ? AND expires_at IS NOT NULL AND expires_at <= ?"
    ).bind(this.groupId, nowTs).all();

    if (expired.length > 0) {
      const ids = expired.map((e) => e.id);
      const placeholders = ids.map(() => "?").join(",");
      await db.batch([
        db.prepare(`DELETE FROM expense_splits WHERE expense_id IN (${placeholders})`).bind(...ids),
        db.prepare(`DELETE FROM expenses WHERE id IN (${placeholders})`).bind(...ids),
      ]);

      // Anyone with the group open watches the expired item disappear live,
      // instead of finding out stale data was there on next reload.
      const freshState = await buildGroupState(db, this.groupId, null);
      if (freshState) this.#broadcast(freshState);
    }

    // Anonymous, short-lived groups (10min/1hour/1day, never claimed by a
    // signed-in account) get fully deleted once they're empty and their own
    // window has elapsed — not just their expenses. This is what actually
    // bounds cost: no account, no email, no reason to keep the group (or
    // this Durable Object) around. Signed-in-owned groups are never touched
    // here regardless of retention.
    const group = await db.prepare(
      "SELECT id, created_by, retention, created_at FROM groups WHERE id = ?"
    ).bind(this.groupId).first();

    if (group && !group.created_by && ANONYMOUS_RETENTIONS.includes(group.retention)) {
      const { count } = await db.prepare(
        "SELECT COUNT(*) as count FROM expenses WHERE group_id = ?"
      ).bind(this.groupId).first();
      const windowMs = RETENTION_MS[group.retention] || 0;
      const windowElapsed = nowTs >= group.created_at + windowMs;

      if (count === 0 && windowElapsed) {
        await db.batch([
          db.prepare("DELETE FROM members WHERE group_id = ?").bind(this.groupId),
          db.prepare("DELETE FROM groups WHERE id = ?").bind(this.groupId),
        ]);
        this.#broadcastRaw({ type: "group_deleted" });
        for (const ws of this.state.getWebSockets()) {
          try { ws.close(1000, "Group expired"); } catch { /* already closed */ }
        }
        await this.state.storage.deleteAll(); // drop this DO's own storage too — nothing left to schedule
        return; // skip the normal recompute below; there's nothing left to schedule
      }
    }

    await this.#recomputeAndSetAlarm();
  }

  // --- Internal request handlers -------------------------------------------

  async #handleSocketUpgrade(request, url) {
    await this.#rememberGroupId(this.#extractGroupIdFromSocketPath(url.pathname));

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);

    // A group that already has expenses but has never had an alarm set
    // (e.g. it existed before this DO-based system did) gets one now, the
    // first time anyone opens it — a self-healing migration path instead of
    // a one-off backfill script.
    await this.#ensureAlarmScheduled();

    return new Response(null, { status: 101, webSocket: client });
  }

  async #handleBroadcast(request, url) {
    await this.#rememberGroupId(url.searchParams.get("groupId"));
    const { state } = await request.json();
    this.#broadcast(state);
    return new Response(null, { status: 204 });
  }

  async #handleSchedule(request, url) {
    await this.#rememberGroupId(url.searchParams.get("groupId"));
    const { reminderAt, expiresAt } = await request.json();

    const candidates = [reminderAt, expiresAt].filter((t) => typeof t === "number");
    if (candidates.length === 0) return new Response(null, { status: 204 });

    const earliestNew = Math.min(...candidates);
    const currentAlarm = await this.state.storage.getAlarm();
    if (currentAlarm === null || earliestNew < currentAlarm) {
      await this.state.storage.setAlarm(earliestNew);
    }
    return new Response(null, { status: 204 });
  }

  async #handleRecompute(request, url) {
    await this.#rememberGroupId(url.searchParams.get("groupId"));
    // Unlike /schedule (which only ever moves the alarm earlier, for the
    // common case of a new expense), this fully recalculates and overwrites
    // the alarm — needed when retention was just extended and the next
    // event moved LATER, e.g. a group just got claimed by a signed-in user.
    await this.#recomputeAndSetAlarm();
    return new Response(null, { status: 204 });
  }

  // --- Small internals -------------------------------------------------------

  #broadcast(state) {
    this.#broadcastRaw({ type: "state", state: stripForBroadcast(state) });
  }

  #broadcastRaw(payload) {
    const json = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(json); } catch { /* socket closed between listing and send; hibernation API reaps it */ }
    }
  }

  #extractGroupIdFromSocketPath(pathname) {
    // Expected shape: /api/groups/:id/socket
    const parts = pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("groups");
    return idx >= 0 ? (parts[idx + 1] ?? null) : null;
  }

  async #rememberGroupId(groupId) {
    if (!groupId || this.groupId === groupId) return;
    this.groupId = groupId;
    await this.state.storage.put("groupId", groupId);
  }

  async #ensureAlarmScheduled() {
    if (!this.groupId) return;
    const currentAlarm = await this.state.storage.getAlarm();
    if (currentAlarm !== null) return;
    await this.#recomputeAndSetAlarm();
  }

  async #recomputeAndSetAlarm() {
    if (!this.groupId) return;
    const next = await findNextAlarmTime(this.env.DB, this.groupId);
    if (next !== null) await this.state.storage.setAlarm(next);
    // else: nothing pending for this group right now. Left unset — the next
    // POST /expenses for this group calls scheduleGroupAlarm(), which will
    // set one.
  }
}