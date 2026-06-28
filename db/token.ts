// Server-side session token helpers.
// Token format: base64url(userId:role:expiry) + "." + HMAC-SHA256 hex
// Requires env var: QMS_SESSION_SECRET (any random string ≥32 chars)

import { createHmac, timingSafeEqual } from "crypto";

const SECRET = process.env.QMS_SESSION_SECRET ?? "";
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}
function fromb64url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}
function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("hex");
}

export interface TokenClaims {
  userId: string;
  role: string;
}

export function issueToken(claims: TokenClaims): string {
  if (!SECRET) throw new Error("QMS_SESSION_SECRET is not set");
  const expiry = Date.now() + TOKEN_TTL_MS;
  const payload = b64url(`${claims.userId}:${claims.role}:${expiry}`);
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

export function verifyToken(token: string): TokenClaims | null {
  if (!SECRET || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // Constant-time comparison to prevent timing attacks
  try {
    const expected = sign(payload);
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch {
    return null;
  }
  const parts = fromb64url(payload).split(":");
  if (parts.length < 3) return null;
  const [userId, role, expiryStr] = parts;
  if (Date.now() > Number(expiryStr)) return null;
  return { userId, role };
}

export function tokenFromRequest(req: Request): TokenClaims | null {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) return verifyToken(auth.slice(7));
  return null;
}
