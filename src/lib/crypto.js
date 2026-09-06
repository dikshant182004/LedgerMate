export const now = () => Date.now();
export const newId = () => crypto.randomUUID();
export const randomToken = () => crypto.randomUUID() + crypto.randomUUID();

// Signs an expense id so the one-click "extend" link in reminder emails
// doesn't need the recipient to be logged in — the signature itself is the
// authorization.
export async function signExpenseId(secret, expenseId) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expenseId));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
