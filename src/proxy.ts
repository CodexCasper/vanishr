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

  // Parse connected list safely
  let connected: string[] = []
  try {
    connected = meta.connected ? JSON.parse(meta.connected as unknown as string) : []
  } catch {
    connected = []
  }

  const existingToken = req.cookies.get("x-auth-token")?.value

  // USER ALREADY IN ROOM → allow
  if (existingToken && connected.includes(existingToken)) {
    return NextResponse.next()
  }

  // ROOM FULL → block
  if (connected.length >= 2) {
    return NextResponse.redirect(new URL("/?error=room-full", req.url))
  }

  // ADD NEW USER
  const response = NextResponse.next()
  const token = nanoid()

  response.cookies.set("x-auth-token", token, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  })

  const updated = [...connected, token]

  await redis.hset(`meta:${roomId}`, {
    connected: JSON.stringify(updated),
  })

  return response
}

export const config = {
  matcher: "/room/:path*",
}