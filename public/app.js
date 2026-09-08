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
const ANONYMOUS_RETENTIONS = ["10min", "1hour", "1day"];
const SIGNIN_RETENTIONS = ["1week", "1month", "6month", "1year", "permanent"];
const RETENTION_LABELS = {
  "10min": "10 min", "1hour": "1 hour", "1day": "1 day",
  "1week": "1 week", "1month": "1 month", "6month": "6 months", "1year": "1 year",
  permanent: "Forever",
};

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
    else if (msg.type === "group_deleted") handleGroupDeleted();
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
  cacheGroupState();
  const composing = !el("sheet-overlay").classList.contains("hidden");
  renderGroup({ skipExpenseForm: composing });
}

// The group's own retention window ran out with nothing left in it, so the
// server deleted it entirely (see the Durable Object's alarm handler). Any
// tab that still has it open needs to bail out to the home screen instead
// of showing stale data or erroring on the next action.
function handleGroupDeleted() {
  if (socket) socket.close();
  toast("This group's time limit was reached, so it was cleaned up.");
  try { localStorage.removeItem(`ledgermate_member_${groupId}`); } catch {}
  groupId = null;
  state = null;
  history.replaceState({}, "", location.pathname);
  el("view-group").classList.add("hidden");
  viewHome.classList.remove("hidden");
  if (currentUser) loadMyGroups();
}

init();

async function init() {
  registerServiceWorker();
  setupSplash();
  initTheme();

  if (params.get("extended") === "1") {
    setTimeout(() => toast("Expense extended by 30 days"), 1600);
    params.delete("extended");
  }

  await fetchMe();
  updateRetentionGateUI();

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
  bindNetworkEvents();
}

function bindNetworkEvents() {
  window.addEventListener("online", () => {
    const banner = el("offline-banner");
    if (banner) banner.classList.add("hidden");
    toast("Connection restored. Syncing live state...");
    if (groupId) {
      loadGroup();
      connectRealtime();
    }
  });

  window.addEventListener("offline", () => {
    const banner = el("offline-banner");
    if (banner) banner.classList.remove("hidden");
    toast("You are offline. Showing cached expenses.");
  });

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const banner = el("offline-banner");
    if (banner) banner.classList.remove("hidden");
  }
}

function setupSplash() {
  const splash = el("splash");
  if (!splash) return;

  // If splash was already played in this tab session, remove immediately without flashing
  if (sessionStorage.getItem("ledgermate_splash_seen")) {
    splash.remove();
    return;
  }
  sessionStorage.setItem("ledgermate_splash_seen", "1");

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    splash.classList.add("splash-fade-out");
    setTimeout(() => {
      if (splash && splash.parentNode) splash.remove();
    }, 400);
  };

  splash.addEventListener("click", dismiss);
  document.addEventListener("keydown", dismiss, { once: true });
  // The badge checkmark completes at ~1.3s; allow full graceful completion before fade out
  setTimeout(dismiss, 1400);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

/* ---------------- theme ---------------- */

function initTheme() {
  [el("theme-toggle-home"), el("theme-toggle-group")].forEach((btn) => {
    if (btn) btn.addEventListener("click", toggleTheme);
  });
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  setTheme(!isDark);
}

function setTheme(dark) {
  if (dark) document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch {}
}

/* ---------------- retention gating (which tiers need sign-in) ---------------- */

function updateRetentionGateUI() {
  const sel = el("group-retention");
  const note = el("retention-signin-note");
  if (!sel || !note) return;
  const needsSignIn = SIGNIN_RETENTIONS.includes(sel.value) && !currentUser;
  note.classList.toggle("hidden", !needsSignIn);
}

function retentionLabel(retention) {
  return RETENTION_LABELS[retention] || retention;
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
    btn.addEventListener("click", () => {
      location.href = `/auth/google/login?return_to=${encodeURIComponent(location.pathname + location.search)}`;
    });
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
    renderAccountSheet();
    openSheet("account-overlay");
  });
  container.appendChild(chip);
}

function renderAccountSheet() {
  if (!currentUser) return;
  const profile = el("account-profile");
  profile.innerHTML = `
    ${currentUser.picture
      ? `<img src="${currentUser.picture}" alt="" />`
      : `<span class="avatar" style="background:${avatarColor(currentUser.name)}">${initials(currentUser.name)}</span>`}
    <div>
      <div class="account-profile-name">${escapeHtml(currentUser.name)}</div>
      <div class="account-profile-email">${escapeHtml(currentUser.email)}</div>
    </div>`;
  loadAccountGroups();
}

async function loadAccountGroups() {
  const list = el("account-groups-list");
  list.innerHTML = `<li class="empty-note">Loading…</li>`;
  try {
    const res = await fetch(`${API}/my/groups`);
    if (!res.ok) { list.innerHTML = `<li class="empty-note">Couldn't load your groups.</li>`; return; }
    const data = await res.json();
    if (data.groups.length === 0) {
      list.innerHTML = `<li class="empty-note">You haven't created any groups yet.</li>`;
      return;
    }
    list.innerHTML = data.groups
      .map((g) => `
        <li><a href="${location.pathname}?g=${g.id}">
          <div>
            <div class="group-name">${escapeHtml(g.name)}</div>
            <div class="group-meta">${g.expense_count} expense${g.expense_count === 1 ? "" : "s"}</div>
          </div>
          <span class="retention-badge">${retentionLabel(g.retention)}</span>
        </a></li>`)
      .join("");
  } catch {
    list.innerHTML = `<li class="empty-note">Couldn't load your groups.</li>`;
  }
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

/* ---------------- offline caching & sync ---------------- */

function cacheGroupState() {
  if (!groupId || !state) return;
  try {
    localStorage.setItem(`ledgermate_group_cache_${groupId}`, JSON.stringify(state));
  } catch {}
}

function getCachedGroupState(gId) {
  try {
    const raw = localStorage.getItem(`ledgermate_group_cache_${gId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setupLoadedGroup({ isOffline = false } = {}) {
  viewHome.classList.add("hidden");
  viewGroup.classList.remove("hidden");

  const banner = el("offline-banner");
  if (banner) banner.classList.toggle("hidden", !isOffline);

  const known = myMemberId(groupId);
  const stillAMember = known && state.members.some((m) => m.id === known);
  if (!stillAMember && !isOffline) {
    promptToJoin();
  } else {
    renderGroup();
    if (!isOffline) connectRealtime();

    let pendingExtend = false;
    try { pendingExtend = sessionStorage.getItem(`ledgermate_pending_extend_${groupId}`) === "1"; } catch {}
    if (pendingExtend && currentUser) {
      try { sessionStorage.removeItem(`ledgermate_pending_extend_${groupId}`); } catch {}
      openSheet("claim-overlay");
    }
  }
}

async function loadGroup() {
  try {
    const res = await fetch(`${API}/groups/${groupId}`);
    if (!res.ok) {
      const cached = getCachedGroupState(groupId);
      if (cached) {
        state = cached;
        setupLoadedGroup({ isOffline: true });
        toast("Offline: Viewing saved expenses from cache");
        return;
      }
      toast("That group link isn't valid.");
      groupId = null;
      history.replaceState({}, "", location.pathname);
      viewHome.classList.remove("hidden");
      return;
    }
    state = await res.json();
    cacheGroupState();
    setupLoadedGroup({ isOffline: false });
  } catch (err) {
    const cached = getCachedGroupState(groupId);
    if (cached) {
      state = cached;
      setupLoadedGroup({ isOffline: true });
      toast("Offline mode: Loaded saved expenses from cache");
      return;
    }
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
  const retentionSelect = el("group-retention");
  if (retentionSelect) retentionSelect.addEventListener("change", updateRetentionGateUI);

  // Pre-fill from query params if coming from a free calculator
  const pName = params.get("name");
  const pCur = params.get("currency");
  const pOwner = params.get("owner");
  if (pName && el("group-name")) el("group-name").value = pName;
  if (pCur && el("group-currency")) el("group-currency").value = pCur;
  if (pOwner && el("owner-name")) el("owner-name").value = pOwner;

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

let currentSettlement = null;

function openShareSheet() {
  renderShareQrCode();
  openSheet("share-overlay");
}

function renderShareQrCode() {
  const box = el("share-qr-box");
  if (!box || !groupId) return;
  const shareUrl = `${location.origin}${location.pathname}?g=${groupId}`;
  if (window.QRCode) {
    box.innerHTML = "";
    new window.QRCode(box, {
      text: shareUrl,
      width: 170,
      height: 170,
      colorDark: "#1C1B29",
      colorLight: "#FFFFFF",
      correctLevel: 1
    });
  }
}

function openSettleSheet(s) {
  currentSettlement = s;
  const cur = state.group.currency;
  el("settle-from-name").textContent = s.from;
  el("settle-to-name").textContent = s.to;
  el("settle-amount-display").textContent = `${cur}${s.amount.toFixed(2)}`;

  const isINR = cur === "₹" || cur === "INR";
  const upiBtn = el("settle-upi-btn");
  if (upiBtn) {
    upiBtn.textContent = isINR ? "Pay via UPI (GPay, PhonePe, Paytm)" : "Pay via UPI / QR";
  }

  openSheet("settle-overlay");
}

function bindSheets() {
  el("fab-add-expense").addEventListener("click", () => {
    openSheet("sheet-overlay");
    switchExpenseMode("standard");
  });
  el("close-expense-sheet").addEventListener("click", () => closeSheet("sheet-overlay"));

  // Quick Action bar on Expenses tab
  if (el("btn-quick-dinner")) {
    el("btn-quick-dinner").addEventListener("click", () => {
      openSheet("sheet-overlay");
      switchExpenseMode("dinner");
    });
  }
  if (el("btn-quick-paste")) {
    el("btn-quick-paste").addEventListener("click", () => {
      openSheet("sheet-overlay");
      switchExpenseMode("quick");
    });
  }
  if (el("btn-quick-add")) {
    el("btn-quick-add").addEventListener("click", () => {
      openSheet("sheet-overlay");
      switchExpenseMode("standard");
    });
  }

  // Share and QR
  if (el("qr-btn")) el("qr-btn").addEventListener("click", openShareSheet);
  el("share-btn").addEventListener("click", openShareSheet);
  el("close-share-sheet").addEventListener("click", () => closeSheet("share-overlay"));

  // Export
  if (el("export-btn")) el("export-btn").addEventListener("click", () => openSheet("export-overlay"));
  if (el("close-export-sheet")) el("close-export-sheet").addEventListener("click", () => closeSheet("export-overlay"));
  if (el("export-csv-btn")) el("export-csv-btn").addEventListener("click", exportCsv);
  if (el("export-print-btn")) el("export-print-btn").addEventListener("click", exportPrintSummary);
  if (el("export-copy-btn")) el("export-copy-btn").addEventListener("click", copyTextSummary);

  // Settle
  if (el("close-settle-sheet")) el("close-settle-sheet").addEventListener("click", () => closeSheet("settle-overlay"));
  if (el("settle-upi-btn")) el("settle-upi-btn").addEventListener("click", onPayUPI);
  if (el("settle-venmo-btn")) el("settle-venmo-btn").addEventListener("click", onPayVenmo);
  if (el("settle-paypal-btn")) el("settle-paypal-btn").addEventListener("click", onPayPayPal);
  if (el("settle-record-btn")) el("settle-record-btn").addEventListener("click", onRecordSettlementPaid);

  // Breakdown ("Why Do I Owe This?")
  if (el("close-breakdown-sheet")) el("close-breakdown-sheet").addEventListener("click", () => closeSheet("breakdown-overlay"));
  if (el("bd-copy-text-btn")) el("bd-copy-text-btn").addEventListener("click", copyBreakdownText);

  // Splitwise CSV Import
  if (el("open-import-btn")) {
    el("open-import-btn").addEventListener("click", () => {
      resetImportSheet();
      openSheet("import-overlay");
    });
  }
  if (el("close-import-sheet")) el("close-import-sheet").addEventListener("click", () => closeSheet("import-overlay"));
  if (el("btn-confirm-import")) el("btn-confirm-import").addEventListener("click", onConfirmImport);
  if (el("btn-cancel-import")) el("btn-cancel-import").addEventListener("click", resetImportSheet);
  
  const dropzone = el("csv-dropzone");
  const fileInput = el("csv-file-input");
  if (dropzone && fileInput) {
    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleCsvFileSelected(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) handleCsvFileSelected(e.target.files[0]);
    });
  }

  // Expense Mode Switcher (Standard, Dinner Mode, Quick Paste)
  if (el("btn-mode-standard")) el("btn-mode-standard").addEventListener("click", () => switchExpenseMode("standard"));
  if (el("btn-mode-dinner")) el("btn-mode-dinner").addEventListener("click", () => switchExpenseMode("dinner"));
  if (el("btn-mode-quick")) el("btn-mode-quick").addEventListener("click", () => switchExpenseMode("quick"));

  // Dinner Mode Controls
  if (el("btn-add-dinner-item")) el("btn-add-dinner-item").addEventListener("click", addDinnerItem);
  if (el("btn-submit-dinner")) el("btn-submit-dinner").addEventListener("click", onSubmitDinnerExpense);
  if (el("dinner-tax-input")) el("dinner-tax-input").addEventListener("input", calculateDinnerTotals);
  if (el("dinner-tip-input")) el("dinner-tip-input").addEventListener("input", calculateDinnerTotals);

  // Quick Paste Controls
  if (el("quick-paste-input")) el("quick-paste-input").addEventListener("input", onQuickPasteInput);
  if (el("btn-submit-quick-paste")) el("btn-submit-quick-paste").addEventListener("click", onSubmitQuickPaste);
  document.querySelectorAll(".quick-chip-btn").forEach((chip) => {
    chip.addEventListener("click", () => {
      const qpInput = el("quick-paste-input");
      const sampleText = chip.dataset.text;
      const myId = myMemberId(groupId);
      const myM = state && state.members ? state.members.find((m) => m.id === myId) : null;
      const payerName = myM ? myM.name : (state && state.members && state.members[0] ? state.members[0].name : "Alex");
      qpInput.value = `${payerName} ${sampleText}`;
      onQuickPasteInput();
    });
  });

  el("close-account-sheet").addEventListener("click", () => closeSheet("account-overlay"));
  el("close-claim-sheet").addEventListener("click", () => closeSheet("claim-overlay"));

  const overlays = [
    el("sheet-overlay"),
    el("share-overlay"),
    el("account-overlay"),
    el("claim-overlay"),
    el("export-overlay"),
    el("settle-overlay"),
    el("breakdown-overlay"),
    el("import-overlay"),
  ].filter(Boolean);

  overlays.forEach((overlay) => {
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSheet(overlay.id); });
  });

  el("copy-link-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(el("share-link").value).then(() => toast("Link copied to clipboard"));
  });

  el("account-signout").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST" });
    location.href = location.pathname + location.search;
  });

  el("extend-banner-dismiss").addEventListener("click", () => {
    try { sessionStorage.setItem(`ledgermate_dismiss_extend_${groupId}`, "1"); } catch {}
    el("extend-banner").classList.add("hidden");
  });

  el("extend-banner-signin").addEventListener("click", () => {
    if (currentUser) {
      openSheet("claim-overlay");
    } else {
      try { sessionStorage.setItem(`ledgermate_pending_extend_${groupId}`, "1"); } catch {}
      location.href = `/auth/google/login?return_to=${encodeURIComponent(location.pathname + location.search)}`;
    }
  });

  el("claim-form").addEventListener("submit", onClaimGroup);
}

function onPayUPI() {
  if (!currentSettlement) return;
  const amt = currentSettlement.amount.toFixed(2);
  const upiUri = `upi://pay?pn=${encodeURIComponent(currentSettlement.to)}&am=${amt}&cu=INR&tn=${encodeURIComponent("LedgerMate Settlement")}`;
  window.location.href = upiUri;
  setTimeout(() => {
    toast(`UPI initiated for ${currentSettlement.to} (${state.group.currency}${amt})`);
  }, 400);
}

function onPayVenmo() {
  if (!currentSettlement) return;
  const amt = currentSettlement.amount.toFixed(2);
  const note = encodeURIComponent(`LedgerMate settlement: ${currentSettlement.from} to ${currentSettlement.to}`);
  const venmoUrl = `https://venmo.com/?txn=pay&audience=private&amount=${amt}&note=${note}`;
  window.open(venmoUrl, "_blank");
}

function onPayPayPal() {
  if (!currentSettlement) return;
  const amt = currentSettlement.amount.toFixed(2);
  window.open("https://paypal.me/", "_blank");
  toast(`Opening PayPal to send ${state.group.currency}${amt} to ${currentSettlement.to}`);
}

async function onRecordSettlementPaid() {
  if (!currentSettlement || !state) return;
  const s = currentSettlement;
  const fromM = state.members.find((m) => m.name === s.from);
  const toM = state.members.find((m) => m.name === s.to);

  if (!fromM || !toM) {
    return toast("Could not locate members for this settlement.");
  }

  const res = await fetch(`${API}/groups/${groupId}/expenses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: `Settlement: ${s.from} paid ${s.to}`,
      amount: s.amount,
      paid_by: fromM.id,
      split_type: "custom",
      splits: [{ member_id: toM.id, amount: s.amount }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return toast(err.error || "Couldn't record settlement.");
  }

  const data = await res.json();
  state = data.state;
  cacheGroupState();
  closeSheet("settle-overlay");
  renderGroup();
  toast(`Recorded payment: ${s.from} paid ${state.group.currency}${s.amount.toFixed(2)} to ${s.to}`);
}

/* ---------------- CSV, PDF & Text Export ---------------- */

function exportCsv() {
  if (!state) return;
  const cur = state.group.currency;
  const gName = state.group.name;
  const safeName = gName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dateStr = new Date().toISOString().slice(0, 10);

  const rows = [];
  rows.push(`"LedgerMate Expense Report: ${gName.replace(/"/g, '""')}"`);
  rows.push(`"Exported On","${new Date().toLocaleString()}"`);
  rows.push(`"Currency","${cur}"`);
  rows.push(`"Total Expenses Logged","${state.expenses.length}"`);
  rows.push("");

  // Itemized Expenses
  rows.push(`"Date","Description","Paid By","Amount (${cur})","Split Type","Split Details"`);
  state.expenses.forEach((e) => {
    const payer = state.members.find((m) => m.id === e.paid_by);
    const payerName = payer ? payer.name : "Unknown";
    const date = new Date(e.created_at).toLocaleDateString();
    const splitDetails = e.splits.map((s) => {
      const m = state.members.find((x) => x.id === s.member_id);
      return `${m ? m.name : "?"}: ${s.amount.toFixed(2)}`;
    }).join("; ");

    rows.push(`"${date}","${e.description.replace(/"/g, '""')}","${payerName.replace(/"/g, '""')}",${e.amount.toFixed(2)},"${e.split_type}","${splitDetails.replace(/"/g, '""')}"`);
  });

  rows.push("");
  // Member Balances
  rows.push(`"Member","Net Balance (${cur})","Status"`);
  state.balances.forEach((b) => {
    const status = Math.abs(b.net) < 0.005 ? "Settled" : (b.net > 0 ? "Is Owed" : "Owes");
    rows.push(`"${b.name.replace(/"/g, '""')}",${b.net.toFixed(2)},"${status}"`);
  });

  rows.push("");
  // Settlements
  rows.push(`"Settlement Payer (From)","Settlement Recipient (To)","Amount (${cur})"`);
  state.settlements.forEach((s) => {
    rows.push(`"${s.from.replace(/"/g, '""')}","${s.to.replace(/"/g, '""')}",${s.amount.toFixed(2)}`);
  });

  const blob = new Blob([rows.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName}_LedgerMate_${dateStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  closeSheet("export-overlay");
  toast("Spreadsheet downloaded (.CSV)");
}

function exportPrintSummary() {
  if (!state) return;
  const cur = state.group.currency;
  const gName = state.group.name;
  const totalSpent = state.expenses.reduce((sum, e) => sum + e.amount, 0);
  const printArea = el("printable-audit-report");
  if (!printArea) return;

  printArea.innerHTML = `
    <h1>${escapeHtml(gName)} — Expense Summary Report</h1>
    <div class="audit-meta">
      <strong>Generated:</strong> ${new Date().toLocaleString()} &nbsp;|&nbsp;
      <strong>Currency:</strong> ${escapeHtml(cur)} &nbsp;|&nbsp;
      <strong>Total Logged:</strong> ${cur}${totalSpent.toFixed(2)} (${state.expenses.length} expenses)
    </div>

    <div class="audit-section-title">Final Balances</div>
    <table>
      <thead>
        <tr><th>Person</th><th>Net Balance</th><th>Status</th></tr>
      </thead>
      <tbody>
        ${state.balances.map((b) => `
          <tr>
            <td><strong>${escapeHtml(b.name)}</strong></td>
            <td>${cur}${Math.abs(b.net).toFixed(2)}</td>
            <td>${Math.abs(b.net) < 0.005 ? "Settled" : (b.net > 0 ? "Gets back" : "Owes")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>

    <div class="audit-section-title">Recommended Settlements</div>
    <table>
      <thead>
        <tr><th>From (Owes)</th><th>To (Is Owed)</th><th>Amount to Settle</th></tr>
      </thead>
      <tbody>
        ${state.settlements.length === 0 ? `<tr><td colspan="3" style="text-align:center;">All debts settled!</td></tr>` : state.settlements.map((s) => `
          <tr>
            <td>${escapeHtml(s.from)}</td>
            <td>${escapeHtml(s.to)}</td>
            <td><strong>${cur}${s.amount.toFixed(2)}</strong></td>
          </tr>
        `).join("")}
      </tbody>
    </table>

    <div class="audit-section-title">Itemized Expense Log</div>
    <table>
      <thead>
        <tr><th>Date</th><th>Description</th><th>Paid By</th><th>Amount</th><th>Split Details</th></tr>
      </thead>
      <tbody>
        ${state.expenses.map((e) => {
          const payer = state.members.find((m) => m.id === e.paid_by);
          return `
            <tr>
              <td>${new Date(e.created_at).toLocaleDateString()}</td>
              <td><strong>${escapeHtml(e.description)}</strong></td>
              <td>${escapeHtml(payer ? payer.name : "Unknown")}</td>
              <td>${cur}${e.amount.toFixed(2)}</td>
              <td>${escapeHtml(e.splits.map((sp) => {
                const mem = state.members.find((m) => m.id === sp.member_id);
                return `${mem ? mem.name : "?"}: ${cur}${sp.amount.toFixed(2)}`;
              }).join(", "))}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
    <p style="font-size:11px;color:#888;margin-top:20px;text-align:center;">
      Created with LedgerMate (https://tryledgermate.in) — Free, real-time group expense splitting.
    </p>
  `;

  closeSheet("export-overlay");
  setTimeout(() => window.print(), 200);
}

function copyTextSummary() {
  if (!state) return;
  const cur = state.group.currency;
  const gName = state.group.name;
  const totalSpent = state.expenses.reduce((sum, e) => sum + e.amount, 0);

  let text = `🧾 LedgerMate: ${gName}\n`;
  text += `Total Spent: ${cur}${totalSpent.toFixed(2)} (${state.expenses.length} expenses)\n\n`;

  text += `📊 Balances:\n`;
  state.balances.forEach((b) => {
    if (Math.abs(b.net) < 0.005) {
      text += `• ${b.name}: Settled\n`;
    } else if (b.net > 0) {
      text += `• ${b.name}: gets back ${cur}${b.net.toFixed(2)}\n`;
    } else {
      text += `• ${b.name}: owes ${cur}${Math.abs(b.net).toFixed(2)}\n`;
    }
  });

  text += `\n🤝 Settle Up:\n`;
  if (state.settlements.length === 0) {
    text += `Everyone is all settled up! 🎉\n`;
  } else {
    state.settlements.forEach((s) => {
      text += `👉 ${s.from} pays ${s.to} ${cur}${s.amount.toFixed(2)}\n`;
    });
  }

  text += `\nView full details: ${location.origin}${location.pathname}?g=${groupId}`;

  navigator.clipboard.writeText(text).then(() => {
    closeSheet("export-overlay");
    toast("Summary copied for WhatsApp / Telegram!");
  }).catch(() => {
    toast("Could not copy to clipboard.");
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
  renderExtendBanner();

  if (isDashboardVisible()) renderDashboard();
}

// Anonymous groups on a short (no-signin) retention tier get a banner
// offering to sign in and extend — the only way to keep them longer, since
// there's no account to email a reminder to in the first place.
function renderExtendBanner() {
  const banner = el("extend-banner");
  if (!state || !state.group) { banner.classList.add("hidden"); return; }

  const eligible = !state.group.created_by && ANONYMOUS_RETENTIONS.includes(state.group.retention);
  let dismissed = false;
  try { dismissed = sessionStorage.getItem(`ledgermate_dismiss_extend_${groupId}`) === "1"; } catch {}

  if (!eligible || dismissed) { banner.classList.add("hidden"); return; }

  banner.classList.remove("hidden");
  el("extend-banner-text").textContent = currentUser
    ? `This group auto-deletes soon (${retentionLabel(state.group.retention)} limit) — extend it to your account?`
    : `This group auto-deletes soon (${retentionLabel(state.group.retention)} limit) — sign in to keep it longer.`;
  el("extend-banner-signin").textContent = currentUser ? "Extend now" : "Sign in & extend";
}

async function onClaimGroup(e) {
  e.preventDefault();
  const retention = el("claim-retention").value;
  const res = await fetch(`${API}/groups/${groupId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ retention }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return toast(err.error || "Couldn't extend this group.");
  }
  const data = await res.json();
  state = { ...data.state, currentUser };
  closeSheet("claim-overlay");
  renderGroup();
  toast("Extended — this group is now saved to your account.");
}

// The "hidden" class only gets toggled by clicking a bottom-nav button — but
// on desktop the nav is hidden and CSS forces every tab-panel visible at
// once (a single scrolling page), so the class never reflects what's
// actually on screen there. offsetParent is null whenever an element (or an
// ancestor) is display:none, so this is true "is this on screen right now"
// regardless of which layout mode is active.
function isDashboardVisible() {
  return el("tab-dashboard").offsetParent !== null;
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
        li.innerHTML = `${avatar}<div class="balance-info"><div class="name">${escapeHtml(b.name)}</div><div class="status">settled up</div></div><div class="balance-end"><button type="button" class="btn-breakdown" title="View transparent math">Why?</button></div>`;
      } else if (b.net > 0) {
        li.className = "balance-owed";
        li.innerHTML = `${avatar}<div class="balance-info"><div class="name">${escapeHtml(b.name)}</div><div class="status">is owed</div></div><div class="balance-end"><span class="balance-amt">${cur}${b.net.toFixed(2)}</span><button type="button" class="btn-breakdown" title="View transparent math">Why?</button></div>`;
      } else {
        li.className = "balance-owes";
        li.innerHTML = `${avatar}<div class="balance-info"><div class="name">${escapeHtml(b.name)}</div><div class="status">owes</div></div><div class="balance-end"><span class="balance-amt">${cur}${Math.abs(b.net).toFixed(2)}</span><button type="button" class="btn-breakdown" title="View transparent math">Why?</button></div>`;
      }
      li.style.cursor = "pointer";
      li.addEventListener("click", () => openBreakdownSheet(b));
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
      li.innerHTML = `
        <div style="flex:1;min-width:0;display:flex;align-items:center;gap:6px;">
          <span>${escapeHtml(s.from)}</span>
          <span class="arrow">→</span>
          <span>${escapeHtml(s.to)}</span>
          <strong>${cur}${s.amount.toFixed(2)}</strong>
        </div>
        <button type="button" class="btn-pay-settle">Pay / Settle</button>
      `;
      const btn = li.querySelector(".btn-pay-settle");
      btn.addEventListener("click", () => openSettleSheet(s));
      settleList.appendChild(li);
    });
  }
}

function renderDashboard() {
  if (!state) return;
  if (!window.Chart) {
    console.warn("Chart.js hasn't loaded yet — dashboard charts will stay blank until it does.");
    return;
  }
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
  cacheGroupState();
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
  cacheGroupState();
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

/* ================= Feature 1: "Why Do I Owe This?" Breakdown ================= */

let currentBreakdownMember = null;

function openBreakdownSheet(b) {
  if (!state || !b) return;
  currentBreakdownMember = b;
  const cur = state.group.currency;

  const isCredit = b.net > 0.005;
  const isDebit = b.net < -0.005;
  const netAbs = Math.abs(b.net).toFixed(2);

  el("breakdown-title").textContent = `Why does ${b.name} ${isCredit ? "get back" : (isDebit ? "owe" : "have balance")} ${cur}${netAbs}?`;
  el("breakdown-subtitle").textContent = `Transparent math and expense breakdown for ${b.name}`;

  // Total paid out of pocket by this member
  const paidExpenses = state.expenses.filter((e) => e.paid_by === b.id);
  const totalPaid = paidExpenses.reduce((sum, e) => sum + e.amount, 0);

  // Total fair share consumed by this member
  let totalConsumed = 0;
  const participatingExpenses = [];

  state.expenses.forEach((e) => {
    const isPayer = e.paid_by === b.id;
    const split = e.splits ? e.splits.find((s) => s.member_id === b.id) : null;
    const share = split ? split.amount : 0;
    if (isPayer || share > 0) {
      totalConsumed += share;
      const netForThis = (isPayer ? e.amount : 0) - share;
      participatingExpenses.push({
        expense: e,
        isPayer,
        share,
        paid: isPayer ? e.amount : 0,
        net: netForThis,
      });
    }
  });

  el("bd-paid-amount").textContent = `${cur}${totalPaid.toFixed(2)}`;
  el("bd-consumed-amount").textContent = `${cur}${totalConsumed.toFixed(2)}`;
  const netEl = el("bd-net-amount");
  netEl.textContent = `${isCredit ? "+" : (isDebit ? "-" : "")}${cur}${netAbs}`;
  netEl.className = "bd-card-val " + (isCredit ? "positive" : (isDebit ? "negative" : ""));

  el("bd-formula-text").textContent = `Paid (${cur}${totalPaid.toFixed(2)}) − Consumed (${cur}${totalConsumed.toFixed(2)}) = Net Balance (${isCredit ? "+" : (isDebit ? "-" : "")}${cur}${netAbs})`;

  // Settlement guidance
  const settleBox = el("bd-settle-text");
  if (!isCredit && !isDebit) {
    settleBox.innerHTML = `<strong>${escapeHtml(b.name)} is completely settled up!</strong> No pending payments or reimbursements.`;
  } else if (isDebit) {
    const myDebts = state.settlements.filter((s) => s.from === b.name);
    if (myDebts.length > 0) {
      settleBox.innerHTML = `To settle up, ${escapeHtml(b.name)} owes:<br>` +
        myDebts.map((s) => `• <strong>${cur}${s.amount.toFixed(2)}</strong> to <strong>${escapeHtml(s.to)}</strong>`).join("<br>");
    } else {
      settleBox.innerHTML = `${escapeHtml(b.name)} owes <strong>${cur}${netAbs}</strong> in total across the group.`;
    }
  } else {
    const myCredits = state.settlements.filter((s) => s.to === b.name);
    if (myCredits.length > 0) {
      settleBox.innerHTML = `${escapeHtml(b.name)} is owed <strong>${cur}${netAbs}</strong>, expected from:<br>` +
        myCredits.map((s) => `• <strong>${cur}${s.amount.toFixed(2)}</strong> from <strong>${escapeHtml(s.from)}</strong>`).join("<br>");
    } else {
      settleBox.innerHTML = `${escapeHtml(b.name)} is owed <strong>${cur}${netAbs}</strong> in total.`;
    }
  }

  // Itemized expense participation list
  el("bd-expenses-count").textContent = `${participatingExpenses.length} expense${participatingExpenses.length === 1 ? "" : "s"}`;
  const list = el("bd-expenses-list");
  list.innerHTML = "";
  if (participatingExpenses.length === 0) {
    list.innerHTML = `<div class="empty-note">${escapeHtml(b.name)} hasn't participated in any expenses yet.</div>`;
  } else {
    participatingExpenses.forEach((item) => {
      const e = item.expense;
      const payer = state.members.find((m) => m.id === e.paid_by);
      const payerName = payer ? payer.name : "Someone";
      const date = new Date(e.created_at).toLocaleDateString();
      const card = document.createElement("div");
      card.className = "bd-exp-card";
      const netColor = item.net > 0 ? "credit" : (item.net < 0 ? "debit" : "");
      card.innerHTML = `
        <div class="bd-exp-info">
          <span class="bd-exp-title">${escapeHtml(e.description)}</span>
          <span class="bd-exp-meta">${escapeHtml(item.isPayer ? "Paid full " + cur + e.amount.toFixed(2) : payerName + " paid " + cur + e.amount.toFixed(2))} • ${date}</span>
        </div>
        <div class="bd-exp-math">
          <div class="bd-exp-net ${netColor}">${item.net > 0 ? "+" : (item.net < 0 ? "-" : "")}${cur}${Math.abs(item.net).toFixed(2)}</div>
          <span class="bd-exp-share">Share: ${cur}${item.share.toFixed(2)}</span>
        </div>
      `;
      list.appendChild(card);
    });
  }

  openSheet("breakdown-overlay");
}

function copyBreakdownText() {
  if (!currentBreakdownMember || !state) return;
  const b = currentBreakdownMember;
  const cur = state.group.currency;
  const paidExpenses = state.expenses.filter((e) => e.paid_by === b.id);
  const totalPaid = paidExpenses.reduce((sum, e) => sum + e.amount, 0);
  let totalConsumed = 0;
  state.expenses.forEach((e) => {
    const split = e.splits ? e.splits.find((s) => s.member_id === b.id) : null;
    if (split) totalConsumed += split.amount;
  });

  let text = `📊 LedgerMate Math Breakdown: ${b.name}\n`;
  text += `Group: ${state.group.name}\n\n`;
  text += `• Total Paid Out-of-Pocket: ${cur}${totalPaid.toFixed(2)}\n`;
  text += `• Fair Share Consumed: ${cur}${totalConsumed.toFixed(2)}\n`;
  text += `• Net Balance: ${b.net >= 0 ? "Gets back +" : "Owes -"}${cur}${Math.abs(b.net).toFixed(2)}\n\n`;

  if (b.net < -0.005) {
    const debts = state.settlements.filter((s) => s.from === b.name);
    if (debts.length > 0) {
      text += `🤝 Recommended Settlement:\n`;
      debts.forEach((s) => { text += `👉 Pay ${s.to} ${cur}${s.amount.toFixed(2)}\n`; });
    }
  } else if (b.net > 0.005) {
    const credits = state.settlements.filter((s) => s.to === b.name);
    if (credits.length > 0) {
      text += `🤝 Expected Reimbursement:\n`;
      credits.forEach((s) => { text += `👈 ${s.from} pays ${b.name} ${cur}${s.amount.toFixed(2)}\n`; });
    }
  }

  text += `\nGroup link: ${location.origin}${location.pathname}?g=${groupId}`;
  navigator.clipboard.writeText(text).then(() => toast("Breakdown copied to clipboard!")).catch(() => toast("Failed to copy."));
}

/* ================= Feature 2: Expense Mode Switcher & Item-Level Dinner Mode ================= */

let dinnerItems = [];

function switchExpenseMode(mode) {
  const stdBtn = el("btn-mode-standard");
  const dinBtn = el("btn-mode-dinner");
  const qpBtn = el("btn-mode-quick");
  const stdForm = el("add-expense-form");
  const dinPanel = el("dinner-mode-panel");
  const qpPanel = el("quick-paste-panel");

  [stdBtn, dinBtn, qpBtn].forEach((b) => b && b.classList.remove("active"));
  [stdForm, dinPanel, qpPanel].forEach((p) => p && p.classList.add("hidden"));

  if (mode === "dinner") {
    if (dinBtn) dinBtn.classList.add("active");
    if (dinPanel) dinPanel.classList.remove("hidden");
    initDinnerMode();
  } else if (mode === "quick") {
    if (qpBtn) qpBtn.classList.add("active");
    if (qpPanel) qpPanel.classList.remove("hidden");
    initQuickPasteMode();
  } else {
    if (stdBtn) stdBtn.classList.add("active");
    if (stdForm) stdForm.classList.remove("hidden");
  }
}

function initDinnerMode() {
  if (!state) return;
  const payerSelect = el("dinner-paid-by");
  const myId = myMemberId(groupId);
  payerSelect.innerHTML = state.members
    .map((m) => `<option value="${m.id}" ${m.id === myId ? "selected" : ""}>${escapeHtml(m.name)}</option>`)
    .join("");

  if (dinnerItems.length === 0) {
    dinnerItems = [
      { id: "item-1", name: "Main course", price: 0, members: state.members.map((m) => m.id) },
      { id: "item-2", name: "Drinks / Cocktails", price: 0, members: state.members.map((m) => m.id) },
    ];
  }
  renderDinnerItems();
  calculateDinnerTotals();
}

function renderDinnerItems() {
  const list = el("dinner-items-list");
  if (!list || !state) return;
  list.innerHTML = "";
  el("dinner-items-count").textContent = `${dinnerItems.length} item${dinnerItems.length === 1 ? "" : "s"}`;

  dinnerItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "dinner-item-row";
    row.dataset.id = item.id;
    row.innerHTML = `
      <div class="dinner-item-top">
        <input type="text" class="dinner-item-name" placeholder="Item (e.g. Pasta, Beer)" value="${escapeHtml(item.name)}" />
        <input type="number" step="0.01" min="0" class="dinner-item-price" placeholder="0.00" value="${item.price > 0 ? item.price : ""}" />
        <button type="button" class="dinner-item-del" title="Remove item" aria-label="Remove item">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
      <div class="dinner-item-members">
        ${state.members.map((m) => {
          const isChecked = item.members.includes(m.id);
          return `<span class="dinner-member-pill ${isChecked ? "checked" : ""}" data-mid="${m.id}">${escapeHtml(m.name)}</span>`;
        }).join("")}
      </div>
    `;

    const nameInput = row.querySelector(".dinner-item-name");
    nameInput.addEventListener("input", (e) => { item.name = e.target.value; });

    const priceInput = row.querySelector(".dinner-item-price");
    priceInput.addEventListener("input", (e) => {
      item.price = parseFloat(e.target.value) || 0;
      calculateDinnerTotals();
    });

    row.querySelector(".dinner-item-del").addEventListener("click", () => {
      dinnerItems = dinnerItems.filter((it) => it.id !== item.id);
      renderDinnerItems();
      calculateDinnerTotals();
    });

    row.querySelectorAll(".dinner-member-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        const mid = pill.dataset.mid;
        if (item.members.includes(mid)) {
          if (item.members.length > 1) {
            item.members = item.members.filter((id) => id !== mid);
            pill.classList.remove("checked");
          } else {
            toast("At least one member must share this item.");
          }
        } else {
          item.members.push(mid);
          pill.classList.add("checked");
        }
        calculateDinnerTotals();
      });
    });

    list.appendChild(row);
  });
}

function addDinnerItem() {
  if (!state) return;
  const newId = "item-" + Date.now();
  dinnerItems.push({
    id: newId,
    name: "",
    price: 0,
    members: state.members.map((m) => m.id),
  });
  renderDinnerItems();
}

function calculateDinnerTotals() {
  if (!state) return { itemsSubtotal: 0, tax: 0, tip: 0, grandTotal: 0, memberShares: [] };
  const cur = state.group.currency;
  const itemsSubtotal = dinnerItems.reduce((sum, it) => sum + (it.price || 0), 0);
  const tax = parseFloat(el("dinner-tax-input").value) || 0;
  const tip = parseFloat(el("dinner-tip-input").value) || 0;
  const grandTotal = itemsSubtotal + tax + tip;

  el("dinner-subtotal-disp").textContent = `${cur}${itemsSubtotal.toFixed(2)}`;
  el("dinner-grand-total").textContent = `${cur}${grandTotal.toFixed(2)}`;

  // Calculate each member's portion proportionally
  const memberShares = state.members.map((m) => {
    let sub = 0;
    dinnerItems.forEach((it) => {
      if (it.members.includes(m.id) && it.members.length > 0) {
        sub += (it.price || 0) / it.members.length;
      }
    });
    const ratio = itemsSubtotal > 0 ? sub / itemsSubtotal : (1 / state.members.length);
    const mTax = tax * ratio;
    const mTip = tip * ratio;
    const total = sub + mTax + mTip;
    return { id: m.id, name: m.name, sub, tax: mTax, tip: mTip, total };
  });

  const previewEl = el("dinner-shares-preview");
  if (previewEl) {
    previewEl.innerHTML = memberShares.map((m) => `
      <div class="dinner-share-item">
        <div>
          <strong>${escapeHtml(m.name)}</strong>
          <span class="dinner-share-detail">Items: ${cur}${m.sub.toFixed(2)} + Tax/Tip: ${cur}${(m.tax + m.tip).toFixed(2)}</span>
        </div>
        <strong>${cur}${m.total.toFixed(2)}</strong>
      </div>
    `).join("");
  }

  return { itemsSubtotal, tax, tip, grandTotal, memberShares };
}

async function onSubmitDinnerExpense() {
  if (!state) return;
  const calc = calculateDinnerTotals();
  if (calc.grandTotal <= 0) return toast("Add at least one item with a valid price.");

  const desc = (el("dinner-desc").value || "Dinner Bill").trim();
  const paidBy = el("dinner-paid-by").value;
  const cur = state.group.currency;

  let roundedSum = 0;
  const splits = calc.memberShares.map((m) => {
    const amt = Math.round(m.total * 100) / 100;
    roundedSum += amt;
    return { member_id: m.id, amount: amt };
  });

  const diff = Math.round((calc.grandTotal - roundedSum) * 100) / 100;
  if (Math.abs(diff) > 0.001 && splits.length > 0) {
    splits[0].amount = Math.round((splits[0].amount + diff) * 100) / 100;
  }

  const res = await fetch(`${API}/groups/${groupId}/expenses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: desc,
      amount: calc.grandTotal,
      paid_by: paidBy,
      split_type: "custom",
      splits,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return toast(err.error || "Couldn't record dinner expense.");
  }

  const data = await res.json();
  state = data.state;
  cacheGroupState();
  closeSheet("sheet-overlay");
  renderGroup();
  toast(`Logged ${desc} (${cur}${calc.grandTotal.toFixed(2)}) with proportional splits!`);
}

/* ================= Feature 4: Quick-Paste Natural Language Parser ================= */

let parsedQuickExpense = null;

function initQuickPasteMode() {
  onQuickPasteInput();
}

function parseExpenseText(rawText) {
  if (!state || !rawText || !rawText.trim()) return null;
  const text = rawText.trim();

  // 1. Extract Amount: supports $45, 45.50, 45
  let amount = null;
  const amtMatch = text.match(/(?:[\$₹€£]|A\$|C\$)?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (amtMatch) {
    amount = parseFloat(amtMatch[1]);
  }

  // 2. Extract Payer
  let payer = null;
  const paidByMatch = text.match(/paid\s+by\s+([a-zA-Z0-9\s]+?)(?:\s+(?:for|with|and|$))/i);
  const payerPaidMatch = text.match(/^([a-zA-Z0-9\s]+?)\s+paid/i);

  const myId = myMemberId(groupId);
  const myMember = state.members.find((m) => m.id === myId);

  if (paidByMatch) {
    const candidate = paidByMatch[1].trim().toLowerCase();
    payer = state.members.find((m) => m.name.toLowerCase().includes(candidate) || candidate.includes(m.name.toLowerCase()));
  } else if (payerPaidMatch) {
    const candidate = payerPaidMatch[1].trim().toLowerCase();
    payer = state.members.find((m) => m.name.toLowerCase().includes(candidate) || candidate.includes(m.name.toLowerCase()));
  }

  if (!payer) {
    payer = myMember || state.members[0];
  }

  // 3. Extract Description
  let desc = "";
  const forMatch = text.match(/for\s+(.+?)(?:\s+(?:with|split|between|by)|$)/i);
  if (forMatch) {
    desc = forMatch[1].trim();
  } else {
    let clean = text.replace(/(?:[\$₹€£]|A\$|C\$)?\s*[0-9]+(?:\.[0-9]{1,2})?/, "")
      .replace(/paid\s+by/i, "")
      .replace(/paid/i, "");
    if (payer) clean = clean.replace(new RegExp(payer.name, "i"), "");
    clean = clean.replace(/with\s+all|everyone/i, "").trim();
    desc = clean || "Expense";
  }

  // 4. Extract Participants
  let splitMembers = [...state.members];
  const withMatch = text.match(/(?:with|split with|between)\s+(.+)$/i);
  if (withMatch) {
    const withText = withMatch[1].trim().toLowerCase();
    if (withText.includes("all") || withText.includes("everyone")) {
      splitMembers = [...state.members];
    } else {
      const matched = state.members.filter((m) => withText.includes(m.name.toLowerCase()));
      if (matched.length > 0) splitMembers = matched;
    }
  }

  return { amount, payer, desc, splitMembers };
}

function onQuickPasteInput() {
  const inputEl = el("quick-paste-input");
  if (!inputEl) return;
  const text = inputEl.value;
  const parsed = parseExpenseText(text);
  parsedQuickExpense = parsed;

  const cur = state ? state.group.currency : "$";
  if (!parsed || !parsed.amount) {
    el("qp-parsed-payer").textContent = parsed && parsed.payer ? parsed.payer.name : "—";
    el("qp-parsed-amount").textContent = "—";
    el("qp-parsed-desc").textContent = parsed && parsed.desc ? parsed.desc : "—";
    el("qp-parsed-split").textContent = "—";
    return;
  }

  el("qp-parsed-payer").textContent = parsed.payer.name;
  el("qp-parsed-amount").textContent = `${cur}${parsed.amount.toFixed(2)}`;
  el("qp-parsed-desc").textContent = parsed.desc;
  el("qp-parsed-split").textContent = parsed.splitMembers.length === state.members.length
    ? "All members (" + parsed.splitMembers.length + ")"
    : parsed.splitMembers.map((m) => m.name).join(", ");
}

async function onSubmitQuickPaste() {
  if (!parsedQuickExpense || !parsedQuickExpense.amount) {
    return toast("Type or paste an expense first (e.g. 'Alex paid 45 for Pizza with all')");
  }

  const p = parsedQuickExpense;
  const cur = state ? state.group.currency : "$";
  const res = await fetch(`${API}/groups/${groupId}/expenses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: p.desc || "Expense",
      amount: p.amount,
      paid_by: p.payer.id,
      split_type: "equal",
      splits: p.splitMembers.map((m) => ({ member_id: m.id })),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return toast(err.error || "Couldn't record expense.");
  }

  const data = await res.json();
  state = data.state;
  cacheGroupState();
  el("quick-paste-input").value = "";
  closeSheet("sheet-overlay");
  renderGroup();
  toast(`Added ${p.desc} (${cur}${p.amount.toFixed(2)})!`);
}

/* ================= Feature 3: Splitwise CSV Migration ================= */

let parsedCsvData = null;

function resetImportSheet() {
  parsedCsvData = null;
  const fileInput = el("csv-file-input");
  if (fileInput) fileInput.value = "";
  el("import-step-upload").classList.remove("hidden");
  el("import-step-preview").classList.add("hidden");
  el("import-progress-status").classList.add("hidden");
  el("btn-confirm-import").disabled = false;
}

function parseCsvLines(csvText) {
  const lines = [];
  let row = [];
  let inQuotes = false;
  let cell = "";
  for (let i = 0; i < csvText.length; i++) {
    const c = csvText[i];
    const next = csvText[i + 1];
    if (c === '"') {
      if (inQuotes && next === '"') { cell += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (c === ',' && !inQuotes) {
      row.push(cell.trim());
      cell = "";
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') i++;
      row.push(cell.trim());
      if (row.some((val) => val.length > 0)) lines.push(row);
      row = [];
      cell = "";
    } else {
      cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((val) => val.length > 0)) lines.push(row);
  }
  return lines;
}

function parseSplitwiseCsv(csvText, fileName = "") {
  const rows = parseCsvLines(csvText);
  if (rows.length < 2) throw new Error("CSV file is empty or missing headers.");

  let defaultGroupName = "Migrated Group";
  if (fileName) {
    defaultGroupName = fileName.replace(/\.[^/.]+$/, "").replace(/Splitwise[_-]?/i, "").replace(/[_-]/g, " ").trim();
  }
  if (!defaultGroupName) defaultGroupName = "Splitwise Group";

  const header = rows[0];
  let dateIdx = header.findIndex((h) => /^date$/i.test(h));
  let descIdx = header.findIndex((h) => /^(description|details)$/i.test(h));
  let costIdx = header.findIndex((h) => /^(cost|amount)$/i.test(h));
  let curIdx = header.findIndex((h) => /^currency$/i.test(h));

  if (dateIdx === -1) dateIdx = 0;
  if (descIdx === -1) descIdx = 1;
  if (costIdx === -1) costIdx = 3;

  const metaIndices = new Set([dateIdx, descIdx, costIdx, curIdx]);
  const catIdx = header.findIndex((h) => /^category$/i.test(h));
  if (catIdx !== -1) metaIndices.add(catIdx);

  const memberNames = [];
  header.forEach((col, idx) => {
    if (!metaIndices.has(idx) && col && !/^(receipt|notes|deleted|id)$/i.test(col)) {
      memberNames.push(col);
    }
  });

  if (memberNames.length === 0) {
    memberNames.push("You", "Friend");
  }

  let detectedCurrency = "$";
  const expenses = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const desc = row[descIdx] || "Expense";
    if (/total balance/i.test(desc) || /group created/i.test(desc)) continue;

    const rawCost = (row[costIdx] || "").replace(/[^0-9.-]/g, "");
    const cost = parseFloat(rawCost);
    if (isNaN(cost) || cost <= 0) continue;

    if (curIdx !== -1 && row[curIdx]) {
      const curCode = row[curIdx].trim().toUpperCase();
      if (curCode === "INR" || curCode === "RS") detectedCurrency = "₹";
      else if (curCode === "EUR") detectedCurrency = "€";
      else if (curCode === "GBP") detectedCurrency = "£";
      else if (curCode === "AUD") detectedCurrency = "A$";
      else if (curCode === "CAD") detectedCurrency = "C$";
      else if (curCode === "USD") detectedCurrency = "$";
    }

    expenses.push({
      date: row[dateIdx] || new Date().toISOString().slice(0, 10),
      description: desc.slice(0, 80),
      amount: cost,
      payerName: memberNames[0],
      memberNames: [...memberNames],
    });
  }

  return {
    groupName: defaultGroupName,
    currency: detectedCurrency,
    members: memberNames,
    expenses,
  };
}

function handleCsvFileSelected(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const text = e.target.result;
      const parsed = parseSplitwiseCsv(text, file.name);
      parsedCsvData = parsed;
      showImportPreview(parsed);
    } catch (err) {
      toast(err.message || "Failed to parse CSV file.");
    }
  };
  reader.readAsText(file);
}

function showImportPreview(data) {
  el("import-step-upload").classList.add("hidden");
  el("import-step-preview").classList.remove("hidden");

  el("import-preview-name").textContent = data.groupName;
  el("import-preview-currency").textContent = data.currency;
  el("import-preview-members").textContent = data.members.length;
  el("import-preview-count").textContent = data.expenses.length;

  el("import-members-list").innerHTML = data.members.map((m) => `<span class="import-member-tag">${escapeHtml(m)}</span>`).join("");

  const tbody = el("import-preview-rows");
  tbody.innerHTML = data.expenses.slice(0, 6).map((exp) => `
    <tr>
      <td>${escapeHtml(exp.date)}</td>
      <td><strong>${escapeHtml(exp.description)}</strong></td>
      <td>${data.currency}${exp.amount.toFixed(2)}</td>
      <td>${escapeHtml(exp.payerName)}</td>
    </tr>
  `).join("");
}

async function onConfirmImport() {
  if (!parsedCsvData) return;
  const data = parsedCsvData;
  const statusEl = el("import-progress-status");
  const textEl = el("import-progress-text");
  const confirmBtn = el("btn-confirm-import");

  confirmBtn.disabled = true;
  statusEl.classList.remove("hidden");
  textEl.textContent = `Creating group "${data.groupName}"...`;

  try {
    // 1. Create Group
    const groupRes = await fetch(`${API}/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: data.groupName,
        currency: data.currency,
        retention: "1day",
      }),
    });
    if (!groupRes.ok) throw new Error("Could not create group.");
    const groupData = await groupRes.json();
    const newGroupId = groupData.id;

    // 2. Add Members
    textEl.textContent = `Adding ${data.members.length} members...`;
    const memberMap = new Map();

    for (let i = 0; i < data.members.length; i++) {
      const mName = data.members[i];
      const mRes = await fetch(`${API}/groups/${newGroupId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: mName }),
      });
      if (mRes.ok) {
        const mData = await mRes.json();
        memberMap.set(mName, mData.id);
        if (i === 0) setMyMemberId(newGroupId, mData.id);
      }
    }

    // 3. Add Expenses
    const totalExp = data.expenses.length;
    for (let i = 0; i < totalExp; i++) {
      const exp = data.expenses[i];
      textEl.textContent = `Importing expense ${i + 1} of ${totalExp}...`;
      const payerId = memberMap.get(exp.payerName) || memberMap.values().next().value;
      const splitIds = exp.memberNames.map((n) => memberMap.get(n)).filter(Boolean);

      await fetch(`${API}/groups/${newGroupId}/expenses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: exp.description,
          amount: exp.amount,
          paid_by: payerId,
          split_type: "equal",
          splits: splitIds.map((id) => ({ member_id: id })),
        }),
      });
    }

    textEl.textContent = "Done! Opening your migrated group...";
    setTimeout(() => {
      location.href = `/app/?g=${newGroupId}`;
    }, 400);
  } catch (err) {
    confirmBtn.disabled = false;
    statusEl.classList.add("hidden");
    toast(err.message || "Failed during import. Please try again.");
  }
}
