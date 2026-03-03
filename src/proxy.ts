import { NextRequest, NextResponse } from "next/server"
import { redis } from "./lib/redis"
import { nanoid } from "nanoid"

export const proxy = async (req: NextRequest) => {
  const pathname = req.nextUrl.pathname

  const roomMatch = pathname.match(/^\/room\/([^/]+)$/)
  if (!roomMatch) return NextResponse.redirect(new URL("/", req.url))

  const roomId = roomMatch[1]

  const meta = await redis.hgetall<{ connected: string; createdAt: number }>(
    `meta:${roomId}`
  )

  if (!meta) {
    return NextResponse.redirect(new URL("/?error=room-not-found", req.url))
  }

  // SAFELY PARSE CONNECTED USERS
  let connected: string[] = []
  try {
    connected = meta.connected ? JSON.parse(meta.connected as unknown as string) : []
  } catch {
    connected = []
  }

  const existingToken = req.cookies.get("x-auth-token")?.value

  //IF USER ALREADY IN ROOM → ALLOW
  if (existingToken && connected.includes(existingToken)) {
    return NextResponse.next()
  }

  // IF ROOM HAS 2 DISTINCT USERS → BLOCK
  if (connected.length >= 2) {
    return NextResponse.redirect(new URL("/?error=room-full", req.url))
  }

  const response = NextResponse.next()

  const token = existingToken ?? nanoid()

  //ROOM-SCOPED COOKIE
  response.cookies.set("x-auth-token", token, {
    path: `/room/${roomId}`,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  })

  // ADD ONLY IF NOT ALREADY PRESENT
  if (!connected.includes(token)) {
    connected.push(token)

    await redis.hset(`meta:${roomId}`, {
      connected: JSON.stringify(connected),
    })
  }

  return response
}

export const config = {
  matcher: "/room/:path*",
}