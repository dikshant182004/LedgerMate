const API = "/api";

const params = new URLSearchParams(location.search);
let groupId = params.get("g");

const el = (id) => document.getElementById(id);
const viewHome = el("view-home");
const viewGroup = el("view-group");

let state = null;
let currentUser = null;
let chartSpend = null;
let chartBalance = null;
let socket = null;
let socketRetryTimer = null;
let socketRetryDelayMs = 1000;

const AVATAR_COLORS = ["#6D4FEB", "#3D6EF0", "#2FA86E", "#E0563F", "#E8A93D", "#17A2B8", "#D6336C", "#495057"];

/* ---------------- "which member am I in this group" (per-browser, no login needed) ---------------- */

function myMemberId(gId) {
  return localStorage.getItem(`ledgermate_member_${gId}`);
}
function setMyMemberId(gId, memberId) {
  localStorage.setItem(`ledgermate_member_${gId}`, memberId);
}

/* ---------------- realtime: one WebSocket per open group ----------------
 * Every mutation (add expense, add member, delete expense) is broadcast by
 * the server to everyone connected to this group, so changes made on one
 * device show up on every other open device without a manual refresh —
 * including the Balances and Dashboard tabs, since they're rendered from
 * the same `state` object. Reconnects automatically with backoff if the
 * connection drops (sleeping laptop, flaky wifi, etc).
 */

function connectRealtime() {
  if (!groupId) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${scheme}//${location.host}${API}/groups/${groupId}/socket`);

  socket.addEventListener("open", () => { socketRetryDelayMs = 1000; });

  socket.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "state") applyIncomingState(msg.state);
  });

  socket.addEventListener("close", scheduleReconnect);
  socket.addEventListener("error", () => socket.close());
}

function scheduleReconnect() {
  if (!groupId) return;
  clearTimeout(socketRetryTimer);
  socketRetryTimer = setTimeout(connectRealtime, socketRetryDelayMs);
  socketRetryDelayMs = Math.min(socketRetryDelayMs * 2, 15000);
}

// Applies a state push that arrived from someone *else's* action.
// `currentUser` is per-viewer and never travels over the realtime channel,
// so it's carried over from what we already have. If the add-expense sheet
// is open, we skip rebuilding that form so we don't wipe out a selection
// the person is still making.
function applyIncomingState(incoming) {
  if (!state) return;
  state = { ...incoming, currentUser: state.currentUser };
  const composing = !el("sheet-overlay").classList.contains("hidden");
  renderGroup({ skipExpenseForm: composing });
}

init();

async function init() {
  registerServiceWorker();
  setupSplash();

  if (params.get("extended") === "1") {
    setTimeout(() => toast("Expense extended by 30 days"), 1600);
    params.delete("extended");
  }

  await fetchMe();

  if (groupId) {
    await loadGroup();
  } else {
    viewHome.classList.remove("hidden");
    if (currentUser) await loadMyGroups();
  }

  bindHomeForm();
  bindGroupForms();
  bindTabs();
  bindSheets();
}

function setupSplash() {
  const splash = el("splash");
  setTimeout(() => splash.remove(), 1900);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

/* ---------------- auth ---------------- */

async function fetchMe() {
  try {
    const res = await fetch(`${API}/me`);
    const data = await res.json();
    currentUser = data.user;
  } catch {
    currentUser = null;
  }
  renderAuthArea(el("auth-area"));
  renderAuthArea(el("auth-area-group"));
}

function renderAuthArea(container) {
  if (!container) return;
  container.innerHTML = "";

  if (!currentUser) {
    const btn = document.createElement("button");
    btn.className = "btn-google";
    btn.innerHTML = `
      <svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.5-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.4 26.7 36 24 36c-5.3 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.2 5.2C40.2 36.5 44 30.9 44 24c0-1.3-.1-2.5-.4-3.5z"/></svg>
      Sign in`;
    btn.addEventListener("click", () => { location.href = "/auth/google/login"; });
    container.appendChild(btn);
    return;
  }

  const chip = document.createElement("button");
  chip.className = "user-chip";
  chip.innerHTML = currentUser.picture
    ? `<img src="${currentUser.picture}" alt="" />`
    : `<span class="avatar" style="background:${avatarColor(currentUser.name)}">${initials(currentUser.name)}</span>`;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAuthMenu(container);
  });
  container.appendChild(chip);
}

function toggleAuthMenu(container) {
  const existing = document.querySelector(".auth-menu");
  if (existing) { existing.remove(); return; }

  const menu = document.createElement("div");
  menu.className = "auth-menu";
  menu.innerHTML = `
    <div style="padding:8px 10px 4px;font-size:12.5px;color:var(--text-muted)">${escapeHtml(currentUser.email)}</div>
    <button id="menu-signout">Sign out</button>`;
  container.style.position = "relative";
  container.appendChild(menu);

  menu.querySelector("#menu-signout").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST" });
    location.href = location.pathname;
  });

  setTimeout(() => document.addEventListener("click", function closeMenu() {
    menu.remove();
    document.removeEventListener("click", closeMenu);
  }), 0);
}

async function loadMyGroups() {
  try {
    const res = await fetch(`${API}/my/groups`);
    if (!res.ok) return;
    const data = await res.json();
    const wrap = el("my-groups-wrap");
    const list = el("my-groups-list");
    if (data.groups.length === 0) return;
    wrap.classList.remove("hidden");
    list.innerHTML = data.groups
      .map((g) => `<li><a href="${location.pathname}?g=${g.id}">${escapeHtml(g.name)}</a></li>`)
      .join("");
  } catch {}
}

/* ---------------- data loading ---------------- */

async function loadGroup() {
  try {
    const res = await fetch(`${API}/groups/${groupId}`);
    if (!res.ok) {
      toast("That group link isn't valid.");
      groupId = null;
      history.replaceState({}, "", location.pathname);
      viewHome.classList.remove("hidden");
      return;
    }
    state = await res.json();
    viewHome.classList.add("hidden");
    viewGroup.classList.remove("hidden");

    const known = myMemberId(groupId);
    const stillAMember = known && state.members.some((m) => m.id === known);
    if (!stillAMember) {
      promptToJoin();
    } else {
      renderGroup();
      connectRealtime();
    }
  } catch (err) {
    toast("Couldn't load the group. Check your connection.");
  }
}

// Whoever opens a shared group link gets added as a member automatically —
// that's the whole reason the link was sent to them. We just need their name.
function promptToJoin() {
  el("join-group-title").textContent = `Join "${state.group.name}"`;
  if (currentUser) el("join-name").value = currentUser.name || "";
  openSheet("join-overlay");
}

async function onJoinGroup(e) {
  e.preventDefault();
  const name = el("join-name").value.trim();
  if (!name) return;
  const res = await fetch(`${API}/groups/${groupId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return toast("Couldn't join the group. Try again.");
  const data = await res.json();
  setMyMemberId(groupId, data.id);
  state = data.state;
  closeSheet("join-overlay");
  renderGroup();
  connectRealtime();
}

/* ---------------- home: create group ---------------- */

function bindHomeForm() {
  el("create-group-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el("group-name").value.trim();
    const ownerName = el("owner-name").value.trim();
    const retention = el("group-retention").value;
    const currency = el("group-currency").value;
    if (!name || !ownerName) return;

    const res = await fetch(`${API}/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, retention, currency }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return toast(err.error || "Couldn't create the group. Try again.");
    }
    const data = await res.json();
    groupId = data.id;
    history.replaceState({}, "", `${location.pathname}?g=${groupId}`);

    // The creator is the first member, added right away — no separate join step for them.
    const memberRes = await fetch(`${API}/groups/${groupId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ownerName }),
    });
    if (!memberRes.ok) return toast("Group created, but couldn't add you as a member. Reload to try again.");

    const member = await memberRes.json();
    setMyMemberId(groupId, member.id);
    state = member.state;

    viewHome.classList.add("hidden");
    viewGroup.classList.remove("hidden");
    renderGroup();
    connectRealtime();
  });
}

/* ---------------- tabs ---------------- */

function bindTabs() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
      el(`tab-${tab}`).classList.remove("hidden");
      if (tab === "dashboard") renderDashboard();
    });
  });
}

/* ---------------- sheets ---------------- */

function bindSheets() {
  el("fab-add-expense").addEventListener("click", () => openSheet("sheet-overlay"));
  el("close-expense-sheet").addEventListener("click", () => closeSheet("sheet-overlay"));
  el("share-btn").addEventListener("click", () => openSheet("share-overlay"));
  el("close-share-sheet").addEventListener("click", () => closeSheet("share-overlay"));

  [el("sheet-overlay"), el("share-overlay")].forEach((overlay) => {
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSheet(overlay.id); });
  });

  el("copy-link-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(el("share-link").value).then(() => toast("Link copied"));
  });
}

function openSheet(id) { el(id).classList.remove("hidden"); document.body.style.overflow = "hidden"; }
function closeSheet(id) { el(id).classList.add("hidden"); document.body.style.overflow = ""; }

/* ---------------- group forms ---------------- */

function bindGroupForms() {
  document.querySelectorAll('input[name="split-type"]').forEach((r) => r.addEventListener("change", renderCustomSplitRows));
  el("add-expense-form").addEventListener("submit", onAddExpense);
  el("join-group-form").addEventListener("submit", onJoinGroup);
}

/* ---------------- rendering ---------------- */

function renderGroup({ skipExpenseForm = false } = {}) {
  el("group-name-header").textContent = state.group.name;
  el("share-link").value = `${location.origin}${location.pathname}?g=${groupId}`;

  renderMembers();
  renderBalances();
  if (!skipExpenseForm) renderExpenseForm();
  renderExpenseList();

  if (!el("tab-dashboard").classList.contains("hidden")) renderDashboard();
}

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function initials(name) {
  return name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

function renderMembers() {
  const list = el("member-list");
  list.innerHTML = "";
  if (state.members.length === 0) { list.innerHTML = `<li class="empty-note">No one added yet.</li>`; return; }
  state.members.forEach((m) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="avatar" style="background:${avatarColor(m.name)}">${initials(m.name)}</span><span>${escapeHtml(m.name)}</span>`;
    list.appendChild(li);
  });
}

function renderBalances() {
  const cur = state.group.currency;
  const balList = el("balance-list");
  balList.innerHTML = "";

  if (state.members.length === 0) {
    balList.innerHTML = `<li class="empty-note">Add people to see balances.</li>`;
  } else {
    state.balances.forEach((b) => {
      const li = document.createElement("li");
      const avatar = `<span class="avatar" style="background:${avatarColor(b.name)}">${initials(b.name)}</span>`;
      if (Math.abs(b.net) < 0.005) {
        li.className = "balance-settled";
        li.innerHTML = `${avatar}<div class="balance-info"><div class="name">${escapeHtml(b.name)}</div><div class="status">settled up</div></div>`;
      } else if (b.net > 0) {
        li.className = "balance-owed";
        li.innerHTML = `${avatar}<div class="balance-info"><div class="name">${escapeHtml(b.name)}</div><div class="status">is owed</div></div><span class="balance-amt">${cur}${b.net.toFixed(2)}</span>`;
      } else {
        li.className = "balance-owes";
        li.innerHTML = `${avatar}<div class="balance-info"><div class="name">${escapeHtml(b.name)}</div><div class="status">owes</div></div><span class="balance-amt">${cur}${Math.abs(b.net).toFixed(2)}</span>`;
      }
      balList.appendChild(li);
    });
  }

  const settleList = el("settle-list");
  settleList.innerHTML = "";
  if (state.settlements.length === 0) {
    settleList.innerHTML = `<li class="empty-note">Everyone's settled up.</li>`;
  } else {
    state.settlements.forEach((s) => {
      const li = document.createElement("li");
      li.innerHTML = `${escapeHtml(s.from)} <span class="arrow">→</span> ${escapeHtml(s.to)} <strong>${cur}${s.amount.toFixed(2)}</strong>`;
      settleList.appendChild(li);
    });
  }
}

function renderDashboard() {
  if (!window.Chart || !state) return;
  const cur = state.group.currency;

  const totalSpent = state.expenses.reduce((a, e) => a + e.amount, 0);
  el("stat-total").textContent = `${cur}${totalSpent.toFixed(2)}`;
  el("stat-count").textContent = state.expenses.length;

  const spendByMember = state.members.map((m) =>
    state.expenses.filter((e) => e.paid_by === m.id).reduce((a, e) => a + e.amount, 0)
  );

  if (chartSpend) chartSpend.destroy();
  chartSpend = new Chart(el("chart-spend"), {
    type: "doughnut",
    data: {
      labels: state.members.map((m) => m.name),
      datasets: [{ data: spendByMember, backgroundColor: state.members.map((m) => avatarColor(m.name)), borderWidth: 0 }],
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } } },
  });

  if (chartBalance) chartBalance.destroy();
  chartBalance = new Chart(el("chart-balance"), {
    type: "bar",
    data: {
      labels: state.balances.map((b) => b.name),
      datasets: [{
        data: state.balances.map((b) => b.net),
        backgroundColor: state.balances.map((b) => (b.net >= 0 ? "#2FA86E" : "#E0563F")),
        borderRadius: 6,
      }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { ticks: { callback: (v) => `${cur}${v}` } } },
    },
  });
}

function renderExpenseForm() {
  const paidBy = el("expense-paid-by");
  const myId = myMemberId(groupId);
  paidBy.innerHTML = state.members
    .map((m) => `<option value="${m.id}" ${m.id === myId ? "selected" : ""}>${escapeHtml(m.name)}</option>`)
    .join("");

  const splitWrap = el("split-members");
  splitWrap.innerHTML = state.members
    .map((m) => `<label class="split-chip checked" data-member="${m.id}"><input type="checkbox" value="${m.id}" checked style="display:none" />${escapeHtml(m.name)}</label>`)
    .join("");

  splitWrap.querySelectorAll(".split-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const input = chip.querySelector("input");
      input.checked = !input.checked;
      chip.classList.toggle("checked", input.checked);
      renderCustomSplitRows();
    });
  });

  renderCustomSplitRows();
}

function renderCustomSplitRows() {
  const isCustom = document.querySelector('input[name="split-type"]:checked').value === "custom";
  const wrap = el("custom-split-rows");
  wrap.classList.toggle("hidden", !isCustom);
  if (!isCustom) return;

  const selectedIds = getSelectedMemberIds();
  wrap.innerHTML = selectedIds
    .map((id) => {
      const m = state.members.find((x) => x.id === id);
      return `<div class="custom-split-row" data-member="${id}"><span>${escapeHtml(m.name)}</span><input type="number" step="0.01" min="0" class="custom-amount" placeholder="0.00" /></div>`;
    })
    .join("");
}

function getSelectedMemberIds() {
  return Array.from(document.querySelectorAll("#split-members input:checked")).map((i) => i.value);
}

function renderExpenseList() {
  const cur = state.group.currency;
  const list = el("expense-list");
  list.innerHTML = "";
  if (state.expenses.length === 0) { list.innerHTML = `<li class="empty-note">No expenses yet — tap + to add the first one.</li>`; return; }
  [...state.expenses].sort((a, b) => b.created_at - a.created_at).forEach((exp) => {
    const payer = state.members.find((m) => m.id === exp.paid_by);
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="expense-icon" style="background:${avatarColor(exp.description)}">${escapeHtml(exp.description[0] || "?").toUpperCase()}</span>
      <div class="expense-main">
        <span class="expense-desc">${escapeHtml(exp.description)}</span>
        <span class="expense-meta">${payer ? escapeHtml(payer.name) : "someone"} paid</span>
      </div>
      <div class="expense-right">
        <span class="expense-amount">${cur}${exp.amount.toFixed(2)}</span>
        <span class="expense-expiry ${exp.expires_at ? "" : "permanent"}">${expiryLabel(exp.expires_at)}</span>
        <button class="btn-danger-text" data-id="${exp.id}">Delete</button>
      </div>`;
    li.querySelector("button").addEventListener("click", () => deleteExpense(exp.id));
    list.appendChild(li);
  });
}

function expiryLabel(expiresAt) {
  if (!expiresAt) return "kept permanently";
  const daysLeft = Math.ceil((expiresAt - Date.now()) / 86400000);
  if (daysLeft <= 0) return "expiring today";
  if (daysLeft === 1) return "expires in 1 day";
  return `expires in ${daysLeft} days`;
}

/* ---------------- actions ---------------- */

async function onAddExpense(e) {
  e.preventDefault();

  const description = el("expense-desc").value.trim();
  const amount = parseFloat(el("expense-amount").value);
  const paidBy = el("expense-paid-by").value;
  const splitType = document.querySelector('input[name="split-type"]:checked').value;
  const selectedIds = getSelectedMemberIds();

  if (!description || !amount || amount <= 0) return toast("Add a description and amount.");
  if (selectedIds.length === 0) return toast("Pick at least one person to split with.");

  let splits;
  if (splitType === "equal") {
    splits = selectedIds.map((id) => ({ member_id: id }));
  } else {
    splits = [];
    let sum = 0, bad = false;
    document.querySelectorAll(".custom-split-row").forEach((row) => {
      const memberId = row.dataset.member;
      const val = parseFloat(row.querySelector(".custom-amount").value);
      if (isNaN(val) || val < 0) bad = true;
      sum += val || 0;
      splits.push({ member_id: memberId, amount: val || 0 });
    });
    if (bad) return toast("Enter a valid amount for each person.");
    if (Math.abs(sum - amount) > 0.01) return toast(`Custom amounts must add up to ${state.group.currency}${amount.toFixed(2)}.`);
  }

  const res = await fetch(`${API}/groups/${groupId}/expenses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description, amount, paid_by: paidBy, split_type: splitType, splits }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return toast(err.error || "Couldn't add that expense.");
  }

  const data = await res.json();
  state = data.state;
  el("add-expense-form").reset();
  closeSheet("sheet-overlay");
  renderGroup();
  toast("Expense added");
}

async function deleteExpense(expenseId) {
  const res = await fetch(`${API}/groups/${groupId}/expenses/${expenseId}`, { method: "DELETE" });
  if (!res.ok) return toast("Couldn't delete that expense.");
  const data = await res.json();
  state = data.state;
  renderGroup();
  toast("Expense deleted");
}

/* ---------------- helpers ---------------- */

function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
