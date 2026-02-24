import { Redis } from "@upstash/redis"
import { nanoid } from "nanoid"
import { NextRequest, NextResponse } from "next/server"

// ---------------------------------------------------------------------------
// Upstash Redis client — safe to use in Edge / Node middleware
// ---------------------------------------------------------------------------
const redis = Redis.fromEnv()

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl

  // Only process /room/<roomId> paths
  const match = pathname.match(/^\/room\/([^/]+)/)
  if (!match) return NextResponse.next()

  const roomId = match[1]

  // -------------------------------------------------------------------------
  // 1. Verify the room exists in Redis
  // -------------------------------------------------------------------------
  const meta = await redis.hgetall<{ connected?: string; createdAt?: string }>(
    `meta:${roomId}`
  )

  if (!meta || Object.keys(meta).length === 0) {
    // Room doesn't exist – redirect to home with a flag
    const url = req.nextUrl.clone()
    url.pathname = "/"
    url.searchParams.set("notFound", "true")
    return NextResponse.redirect(url)
  }

  // -------------------------------------------------------------------------
  // 2. Parse the current connected-tokens list
  //    Upstash stores JS arrays as JSON strings when set via hset(), so we
  //    need to handle both a raw array (already parsed) and a JSON string.
  // -------------------------------------------------------------------------
  let connected: string[] = []

  if (meta.connected) {
    if (Array.isArray(meta.connected)) {
      connected = meta.connected as string[]
    } else {
      try {
        const parsed = JSON.parse(meta.connected as string)
        connected = Array.isArray(parsed) ? parsed : []
      } catch {
        connected = []
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Check whether this browser already has a valid cookie for this room.
  //    Cookie name is per-room to prevent token leakage across rooms.
  // -------------------------------------------------------------------------
  const cookieName = `x-auth-token-${roomId}`
  const existingToken = req.cookies.get(cookieName)?.value

  if (existingToken) {
    // Token exists – let the request through without touching Redis.
    // (The Elysia authMiddleware will re-validate against connected[] on API
    // calls, so any truly invalid stale cookie will be caught there.)
    return NextResponse.next()
  }

  // -------------------------------------------------------------------------
  // 4. No cookie yet – enforce capacity before admitting a new user.
  //    Count DISTINCT tokens to tolerate any legacy duplicates in Redis.
  // -------------------------------------------------------------------------
  const distinctUsers = new Set(connected.filter(Boolean)).size

  if (distinctUsers >= 2) {
    const url = req.nextUrl.clone()
    url.pathname = "/"
    url.searchParams.set("roomFull", "true")
    return NextResponse.redirect(url)
  }

  // -------------------------------------------------------------------------
  // 5. Assign a new token and register it in Redis atomically.
  //    We append to the existing array and write it back in one hset call.
  //    The room TTL was already set on creation; we don't touch it here.
  // -------------------------------------------------------------------------
  const newToken = nanoid()
  const updatedConnected = [...connected, newToken]

  await redis.hset(`meta:${roomId}`, {
    connected: updatedConnected,
  })

  // -------------------------------------------------------------------------
  // 6. Set the scoped, HttpOnly cookie and allow the request through.
  // -------------------------------------------------------------------------
  const response = NextResponse.next()

  response.cookies.set(cookieName, newToken, {
    path: `/room/${roomId}`,   // Browser only sends this cookie to this room's path
    httpOnly: true,            // Inaccessible to JS – reduces XSS surface
    sameSite: "lax",           // Safe for normal navigation & link sharing
    secure: true            // Uncomment in production (HTTPS)
  })

  return response
}

// ---------------------------------------------------------------------------
// Route matcher – only run middleware on /room/* pages (not on /api/* etc.)
// ---------------------------------------------------------------------------
export const config = {
  matcher: ["/room/:roomId*"],
}
