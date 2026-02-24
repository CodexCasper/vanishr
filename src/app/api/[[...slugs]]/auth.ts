import { redis } from "@/lib/redis"
import Elysia from "elysia"

class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuthError"
  }
}

// ---------------------------------------------------------------------------
// Safe parser for the `connected` field stored in Redis.
//
// middleware.ts writes `connected` via Lua's `cjson.encode` (a JSON string).
// Upstash's `hget` auto-deserializes valid JSON, so it can return either:
//   - string[]  — when Upstash deserializes the JSON array for us
//   - string    — when it receives an unexpected raw string
//   - null      — when the field or key does not exist
//
// This helper normalises all three cases to string[].
// ---------------------------------------------------------------------------
function parseConnected(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

export const authMiddleware = new Elysia({ name: "auth" })
  .error({ AuthError })
  .onError(({ code, set }) => {
    if (code === "AuthError") {
      set.status = 401
      return { error: "Unauthorized" }
    }
  })
  .derive({ as: "scoped" }, async ({ query, cookie }) => {
    const roomId = query.roomId
    // Cookie name is scoped per-room to match the Next.js middleware
    const token = cookie[`x-auth-token-${roomId}`]?.value as string | undefined

    if (!roomId || !token) {
      throw new AuthError("Missing roomId or token.")
    }

    const raw = await redis.hget(`meta:${roomId}`, "connected")
    const connected = parseConnected(raw)

    if (!connected.includes(token)) {
      throw new AuthError("Invalid token")
    }

    return { auth: { roomId, token, connected } }
  })