import type { Config } from "@netlify/functions";
import { createHash, pbkdf2 as pbkdf2Cb } from "crypto";
import { promisify } from "util";
import { db } from "../../db/index.js";
import { qamsData } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { issueToken } from "../../db/token.js";

// POST /api/auth  { username, password }
// Returns { token, role, displayName } on success, 401 on failure.
// The token is a server-signed HMAC credential the client includes as
// Authorization: Bearer <token> on every subsequent API request.

const pbkdf2 = promisify(pbkdf2Cb);

// Hardcoded fallback users (same as the client-side defaults).
// These activate when the users bucket is empty / DB unavailable.
const DEFAULT_USERS = [
  { id: "admin",      username: "Admin", password: "cellcard", role: "admin",      displayName: "Administrator",  status: "active" },
  { id: "superadmin", username: "Super", password: "cellcard", role: "superadmin", displayName: "Super Admin",    status: "active" },
];

interface UserRecord {
  id: string;
  username: string;
  password: string;
  role: string;
  displayName?: string;
  status?: string;
}

async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  // PBKDF2: "pbkdf2:{iterations}:{saltHex}:{hashHex}"
  if (stored.startsWith("pbkdf2:")) {
    const parts = stored.split(":");
    if (parts.length < 4) return false;
    const iters = parseInt(parts[1], 10);
    const salt  = Buffer.from(parts[2], "hex");
    const expected = parts[3];
    const derived = await pbkdf2(plain, salt, iters, 32, "sha256");
    return derived.toString("hex") === expected;
  }
  // Legacy SHA-256: 64-char hex string
  if (/^[0-9a-f]{64}$/.test(stored)) {
    const hash = createHash("sha256").update(plain).digest("hex");
    return hash === stored;
  }
  // Plaintext legacy
  return plain === stored;
}

async function getUsers(): Promise<UserRecord[]> {
  try {
    const rows = await db
      .select({ data: qamsData.data })
      .from(qamsData)
      .where(eq(qamsData.bucket, "users"));
    if (rows.length && Array.isArray(rows[0].data) && rows[0].data.length > 0) {
      const dbUsers = rows[0].data as UserRecord[];
      // Merge DB users with defaults so hardcoded admin/superadmin always exist
      const ids = new Set(dbUsers.map((u) => u.id));
      return [...dbUsers, ...DEFAULT_USERS.filter((u) => !ids.has(u.id))];
    }
  } catch {
    // DB unreachable — fall through to defaults
  }
  return DEFAULT_USERS;
}

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  if (!username || !password) {
    return Response.json({ error: "username and password required" }, { status: 400 });
  }

  const users = await getUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());

  if (!user || user.status === "inactive") {
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const valid = await verifyPassword(password, user.password);
  if (!valid) {
    return Response.json({ error: "Invalid credentials" }, { status: 401 });
  }

  if (!process.env.QMS_SESSION_SECRET) {
    // Secret not configured — issue a degraded token so the app still works
    // but log a warning so operators know to set it.
    console.warn("QMS_SESSION_SECRET is not set. Server-side auth tokens are unsigned.");
  }

  let token: string | null = null;
  try {
    token = issueToken({ userId: user.id, role: user.role });
  } catch {
    // issueToken throws when secret is absent — treat as unsigned (client-only auth)
    token = null;
  }

  return Response.json({
    ok: true,
    token,
    userId: user.id,
    role: user.role,
    displayName: user.displayName ?? user.username,
  });
};

export const config: Config = { path: "/api/auth" };
