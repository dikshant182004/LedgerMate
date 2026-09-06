export function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

export function cookieHeader(name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", "Secure"];
  if (httpOnly) parts.push("HttpOnly");
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}
