import { stripForBroadcast } from "./group-state.js";

// One GroupRoom Durable Object instance per group, addressed deterministically
// by group id — every request for the same groupId resolves to the same
// single instance, which is what makes it a valid place to hold "who's
// connected" and "when's the next alarm" for that group.
function getGroupRoomStub(env, groupId) {
  const id = env.GROUP_ROOM.idFromName(groupId);
  return env.GROUP_ROOM.get(id);
}

// Pushes fresh state to every client currently connected to this group's
// realtime channel. Fire-and-forget from the caller's point of view — the
// caller (an HTTP route) already has its own copy of `state` for its own
// response, so a failed or slow broadcast should never block or fail the
// caller's request. Callers should wrap this in `c.executionCtx.waitUntil(...)`
// so it keeps running after the HTTP response has already been sent.
export async function broadcastGroupState(env, groupId, state) {
  const stub = getGroupRoomStub(env, groupId);
  await stub.fetch(`https://group-room/broadcast?groupId=${groupId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: stripForBroadcast(state) }),
  }).catch(() => {});
}

// Tells the group's DO that a new expiry-related event exists (a reminder
// time and/or a deletion time), so it can bring its alarm forward if this
// event is sooner than whatever it already has scheduled. Cheap to call on
// every expense creation — the DO itself decides whether it needs to move
// its alarm.
export async function scheduleGroupAlarm(env, groupId, { reminderAt, expiresAt } = {}) {
  if (reminderAt == null && expiresAt == null) return;
  const stub = getGroupRoomStub(env, groupId);
  await stub.fetch(`https://group-room/schedule?groupId=${groupId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reminderAt, expiresAt }),
  }).catch(() => {});
}

// Tells the group's DO to fully recalculate its alarm from scratch, rather
// than only moving it earlier (which is all scheduleGroupAlarm does). Needed
// when retention was just extended — e.g. an anonymous group got claimed by
// a signed-in account and its expiry moved LATER, not sooner.
export async function recomputeGroupAlarm(env, groupId) {
  const stub = getGroupRoomStub(env, groupId);
  await stub.fetch(`https://group-room/recompute?groupId=${groupId}`, { method: "POST" }).catch(() => {});
}

// Forwards a WebSocket upgrade request straight through to the group's DO.
// This is the only realtime.js function that returns a Response directly to
// the client rather than firing-and-forgetting.
export function connectToGroupRoom(env, groupId, request) {
  const stub = getGroupRoomStub(env, groupId);
  return stub.fetch(request);
}