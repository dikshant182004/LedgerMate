import { DAY_MS } from "../services/group-state.js";
import { signExpenseId } from "./crypto.js";

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Best-effort: a failed send should never block cleanup or crash the caller
// (a GroupRoom alarm), so this swallows its own errors.
export async function sendReminderEmail(env, expense, group, toEmail) {
  const sig = await signExpenseId(env.EXTEND_SECRET, expense.id);
  const extendUrl = `${env.APP_URL}/api/expenses/${expense.id}/extend?sig=${sig}`;
  const groupUrl = `${env.APP_URL}/?g=${group.id}`;
  const daysLeft = Math.max(1, Math.ceil((expense.expires_at - Date.now()) / DAY_MS));

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [toEmail],
      subject: `"${expense.description}" is expiring in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
      html: `
        <p>Hey,</p>
        <p>Your expense <strong>${escapeHtml(expense.description)}</strong> (${group.currency}${expense.amount.toFixed(2)})
        in the group <strong>${escapeHtml(group.name)}</strong> will be automatically deleted in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.</p>
        <p>If it's already settled, you can ignore this — it'll clean itself up.
        If you'd like to keep it a little longer, click below:</p>
        <p><a href="${extendUrl}" style="background:#3D6EF0;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Extend by 30 days</a></p>
        <p><a href="${groupUrl}">Open the group</a></p>
      `,
    }),
  }).catch(() => {});
}
