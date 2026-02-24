import { Redis } from "@upstash/redis"
import { nanoid } from "nanoid"
import { NextRequest, NextResponse } from "next/server"

const redis = Redis.fromEnv()

// ---------------------------------------------------------------------------
// Atomic Lua script — mirrors the one in middleware.ts exactly.
// Runs as a single Redis transaction to eliminate race conditions.
//
// Return values:
//   -1  room does not exist
//    0  room is full (≥ 2 distinct tokens already in connected[])
//    1  token was atomically appended — user is admitted
// ---------------------------------------------------------------------------
const LUA_JOIN = `
local exists = redis.call('EXISTS', KEYS[1])
if exists == 0 then return -1 end

local raw = redis.call('HGET', KEYS[1], 'connected')
local connected = {}

if raw then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == 'table' then
    connected = parsed
  end
end

-- count DISTINCT tokens (tolerates legacy duplicates already in Redis)
local seen = {}
local count = 0
for _, v in ipairs(connected) do
  if not seen[v] then
    seen[v] = true
    count = count + 1
  end
end

if count >= tonumber(ARGV[2]) then return 0 end

table.insert(connected, ARGV[1])
redis.call('HSET', KEYS[1], 'connected', cjson.encode(connected))
return 1
`

export const proxy = async (req: NextRequest): Promise<NextResponse> => {
  const { pathname } = req.nextUrl

  const match = pathname.match(/^\/room\/([^/]+)/)
  if (!match) return NextResponse.next()

  const roomId = match[1]

  // -------------------------------------------------------------------------
  // Fast path: room-scoped cookie already present → let the request through.
  // No Redis call needed.
  // -------------------------------------------------------------------------
  const cookieName = `x-auth-token-${roomId}`
  const existingToken = req.cookies.get(cookieName)?.value

  if (existingToken) {
    return NextResponse.next()
  }

  // -------------------------------------------------------------------------
  // Slow path: no cookie → run the atomic Lua script.
  // Checks room existence, enforces the 2-user cap, and appends the new token
  // all in a single Redis round-trip with no race window.
  // -------------------------------------------------------------------------
  const newToken = nanoid()

  const result = (await redis.eval(
    LUA_JOIN,
    [`meta:${roomId}`],
    [newToken, "2"]
  )) as number

  if (result === -1) {
    // Room does not exist
    const url = req.nextUrl.clone()
    url.pathname = "/"
    url.searchParams.set("notFound", "true")
    return NextResponse.redirect(url)
  }

  if (result === 0) {
    // Room is full
    const url = req.nextUrl.clone()
    url.pathname = "/"
    url.searchParams.set("roomFull", "true")
    return NextResponse.redirect(url)
  }

  // -------------------------------------------------------------------------
  // Token registered — set the per-room scoped cookie.
  // Path=/room/{roomId} means the browser only sends this cookie to THIS room,
  // preventing token leakage when a user has visited multiple rooms.
  // -------------------------------------------------------------------------
  const response = NextResponse.next()

  response.cookies.set(cookieName, newToken, {
    path: `/room/${roomId}`,
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  })

  return response
}

export const config = {
  matcher: "/room/:path*",
}