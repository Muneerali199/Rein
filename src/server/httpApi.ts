/**
 * src/server/httpApi.ts
 *
 * HTTP REST API handlers — replaces WebSocket one-shot messages.
 *
 * Endpoints registered in vite.config.ts via server.middlewares.use():
 *
 *   OPTIONS /api/*           → CORS preflight (200)
 *   GET  /api/ip             → { ip: string }
 *   POST /api/token          → { token: string }        (localhost only)
 *   POST /api/config         → { ok: true }             (localhost only)
 *
 * WebRTC signalling (used by useWebRTCProvider + useWebRTCMirror):
 *   POST   /api/signal             → { sessionId }
 *   GET    /api/signal/:id         → { offer, ice }  or long-poll for answer
 *   POST   /api/signal/:id/answer  → { ok: true }
 *   POST   /api/signal/:id/ice     → { ok: true }
 *   DELETE /api/signal/:id         → { ok: true }
 */
import fs from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { generateToken, getActiveToken, isKnownToken, storeToken, touchToken } from "./tokenStore"
import { getLocalIp } from "./getLocalIp"

// ─── helpers ────────────────────────────────────────────────────────────────

function isLocalhost(req: IncomingMessage): boolean {
	const addr = req.socket.remoteAddress
	if (!addr) return false
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = ""
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString()
			if (body.length > 64 * 1024) reject(new Error("Payload too large"))
		})
		req.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : {})
			} catch {
				resolve({})
			}
		})
		req.on("error", reject)
	})
}

// CORS headers added to every /api response so browser fetch() works
// cross-origin (e.g. phone on same LAN accessing the desktop's IP).
const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
}

function json(res: ServerResponse, status: number, data: unknown) {
	const body = JSON.stringify(data)
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body),
		...CORS_HEADERS,
	})
	res.end(body)
}

function unauthorized(res: ServerResponse) {
	json(res, 401, { error: "Unauthorized" })
}

// ─── WebRTC signalling in-memory store ─────────────────────────────────────
//
// Single-session design: at most one active WebRTC session on the LAN at a
// time.  The provider (desktop) creates a session by POSTing an SDP offer.
// The viewer (phone) retrieves the offer via GET and posts back an SDP answer.
// ICE candidates are exchanged via POST /api/signal/:id/ice (trickle ICE).
//
// Long-poll pattern: GET /api/signal/:id?role=provider holds the request open
// for up to POLL_TIMEOUT_MS waiting for the answer.  To avoid a TOCTOU race
// (answer arriving between the `if (!session.answer)` check and registering
// the waiter) we register the waiter first, then re-check inside the promise.

const POLL_TIMEOUT_MS = 15_000
const SESSION_TTL_MS  = 60_000

// SDP / ICE shapes — plain JSON objects passed through opaquely.
// Local interfaces avoid depending on browser DOM globals unavailable in Node.
interface SdpInit {
	type: string
	sdp?: string
}
interface IceCandidateInit {
	candidate: string
	sdpMid?: string | null
	sdpMLineIndex?: number | null
}

interface SignalSession {
	offer:        SdpInit
	answer:       SdpInit | null
	/** ICE candidates accumulated from the provider (desktop → viewer) */
	providerIce:  IceCandidateInit[]
	/** ICE candidates accumulated from the viewer (phone → provider) */
	viewerIce:    IceCandidateInit[]
	/** Resolve fn of the active long-poll (provider side), if any */
	answerWaiter: (() => void) | null
	createdAt:    number
}

const sessions = new Map<string, SignalSession>()

/** Prune sessions older than SESSION_TTL_MS to prevent unbounded growth. */
function pruneSessions() {
	const now = Date.now()
	for (const [id, s] of sessions) {
		if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id)
	}
}

// ─── IP cache ───────────────────────────────────────────────────────────────

let cachedIp: string | null = null

// ─── main middleware ─────────────────────────────────────────────────────────

export function createHttpApiMiddleware() {
	return async function httpApiMiddleware(
		req: IncomingMessage,
		res: ServerResponse,
		next: () => void,
	) {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
		const path = url.pathname

		// Only handle /api/* routes
		if (!path.startsWith("/api/")) {
			next()
			return
		}

		// ── OPTIONS preflight (CORS) ───────────────────────────────────────────
		// Browsers send a preflight OPTIONS request before cross-origin POSTs.
		// Without this, all cross-origin fetch() calls will fail in the browser.
		if (req.method === "OPTIONS") {
			res.writeHead(204, CORS_HEADERS)
			res.end()
			return
		}

		// ── GET /api/ip ────────────────────────────────────────────────────────
		if (req.method === "GET" && path === "/api/ip") {
			if (!cachedIp) cachedIp = await getLocalIp()
			return json(res, 200, { ip: cachedIp })
		}

		// ── POST /api/token ────────────────────────────────────────────────────
		// Generates (or returns) the active auth token.  Localhost-only.
		if (req.method === "POST" && path === "/api/token") {
			if (!isLocalhost(req)) return unauthorized(res)
			let token = getActiveToken()
			if (!token) {
				token = generateToken()
				storeToken(token)
			} else {
				// Refresh lastUsed so the token doesn't expire while in active use
				touchToken(token)
			}
			return json(res, 200, { token })
		}

		// ── POST /api/config ───────────────────────────────────────────────────
		// Updates server-config.json.  Localhost-only.
		if (req.method === "POST" && path === "/api/config") {
			if (!isLocalhost(req)) return unauthorized(res)
			try {
				const body = (await readBody(req)) as Record<string, unknown>
				const ALLOWED_KEYS = ["host", "frontendPort", "address", "inputThrottleMs"]
				const filtered: Record<string, unknown> = {}
				for (const key of ALLOWED_KEYS) {
					if (!(key in body)) continue
					if (key === "frontendPort") {
						const n = Number(body[key])
						if (!Number.isFinite(n) || n < 1 || n > 65535) {
							return json(res, 400, { error: "Invalid value for frontendPort (must be 1–65535)" })
						}
						filtered[key] = Math.floor(n)
					} else if (key === "inputThrottleMs") {
						const n = Number(body[key])
						if (!Number.isFinite(n) || n < 1 || n > 1000) {
							return json(res, 400, { error: "Invalid value for inputThrottleMs (must be 1–1000)" })
						}
						filtered[key] = Math.floor(n)
					} else if (typeof body[key] === "string" && (body[key] as string).length <= 255) {
						filtered[key] = body[key]
					}
				}
				if (Object.keys(filtered).length === 0) {
					return json(res, 400, { error: "No valid keys provided" })
				}
				const configPath = "./src/server-config.json"
				const current = fs.existsSync(configPath)
					? (JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>)
					: {}
				fs.writeFileSync(configPath, JSON.stringify({ ...current, ...filtered }, null, 2))
				return json(res, 200, { ok: true })
			} catch (e) {
				return json(res, 500, { error: String(e) })
			}
		}

		// ── POST /api/signal ───────────────────────────────────────────────────
		// Provider posts an SDP offer to create a new signalling session.
		// Returns a sessionId the viewer uses to retrieve the offer.
		if (req.method === "POST" && path === "/api/signal") {
			const token = url.searchParams.get("token")
			if (!isLocalhost(req) && (!token || !isKnownToken(token))) {
				return unauthorized(res)
			}
			pruneSessions()
			const body = (await readBody(req)) as { offer?: SdpInit }
			if (!body.offer?.type || !body.offer?.sdp) {
				return json(res, 400, { error: "Missing offer" })
			}
			const sessionId = crypto.randomUUID()
			sessions.set(sessionId, {
				offer: body.offer,
				answer: null,
				providerIce: [],
				viewerIce: [],
				answerWaiter: null,
				createdAt: Date.now(),
			})
			return json(res, 200, { sessionId })
		}

		// ── GET /api/signal/:id ────────────────────────────────────────────────
		// Viewer: returns offer + provider ICE candidates immediately.
		// Provider: long-polls (up to POLL_TIMEOUT_MS) for the SDP answer.
		const signalGetMatch = path.match(/^\/api\/signal\/([^/]+)$/)
		if (req.method === "GET" && signalGetMatch) {
			const sessionId = signalGetMatch[1]
			const token = url.searchParams.get("token")
			if (!isLocalhost(req) && (!token || !isKnownToken(token))) {
				return unauthorized(res)
			}
			const session = sessions.get(sessionId)
			if (!session) return json(res, 404, { error: "Session not found" })

			const role = url.searchParams.get("role")

			if (role === "provider") {
				// Register the waiter BEFORE checking session.answer to eliminate
				// the TOCTOU race where the answer arrives between the check and
				// the Promise constructor.
				await new Promise<void>((resolve) => {
					if (session.answer) {
						// Answer already arrived — resolve immediately
						resolve()
						return
					}
					const timeout = setTimeout(() => {
						session.answerWaiter = null
						resolve()
					}, POLL_TIMEOUT_MS)
					session.answerWaiter = () => {
						clearTimeout(timeout)
						session.answerWaiter = null
						resolve()
					}
				})
				if (session.answer) {
					return json(res, 200, { answer: session.answer, ice: session.viewerIce })
				}
				return json(res, 408, { error: "Timeout waiting for answer" })
			}

			// Viewer: return offer + any provider ICE candidates
			return json(res, 200, { offer: session.offer, ice: session.providerIce })
		}

		// ── POST /api/signal/:id/answer ────────────────────────────────────────
		// Viewer posts its SDP answer; wakes the provider long-poll.
		const signalAnswerMatch = path.match(/^\/api\/signal\/([^/]+)\/answer$/)
		if (req.method === "POST" && signalAnswerMatch) {
			const sessionId = signalAnswerMatch[1]
			const token = url.searchParams.get("token")
			if (!isLocalhost(req) && (!token || !isKnownToken(token))) {
				return unauthorized(res)
			}
			const session = sessions.get(sessionId)
			if (!session) return json(res, 404, { error: "Session not found" })
			const body = (await readBody(req)) as { answer?: SdpInit }
			if (!body.answer?.type || !body.answer?.sdp) {
				return json(res, 400, { error: "Missing answer" })
			}
			// Store the answer first, then wake the waiter — guarantees the
			// provider long-poll always reads a non-null answer after waking.
			session.answer = body.answer
			session.answerWaiter?.()
			return json(res, 200, { ok: true })
		}

		// ── POST /api/signal/:id/ice ───────────────────────────────────────────
		// Either side trickles ICE candidates.
		// Body: { candidate: IceCandidateInit, role: "provider" | "viewer" }
		const signalIceMatch = path.match(/^\/api\/signal\/([^/]+)\/ice$/)
		if (req.method === "POST" && signalIceMatch) {
			const sessionId = signalIceMatch[1]
			const token = url.searchParams.get("token")
			if (!isLocalhost(req) && (!token || !isKnownToken(token))) {
				return unauthorized(res)
			}
			const session = sessions.get(sessionId)
			if (!session) return json(res, 404, { error: "Session not found" })
			const body = (await readBody(req)) as { candidate?: IceCandidateInit; role?: string }
			if (!body.candidate) return json(res, 400, { error: "Missing candidate" })
			if (body.role === "viewer") {
				session.viewerIce.push(body.candidate)
			} else {
				session.providerIce.push(body.candidate)
			}
			return json(res, 200, { ok: true })
		}

		// ── DELETE /api/signal/:id ─────────────────────────────────────────────
		const signalDeleteMatch = path.match(/^\/api\/signal\/([^/]+)$/)
		if (req.method === "DELETE" && signalDeleteMatch) {
			const session = sessions.get(signalDeleteMatch[1])
			// Wake any waiting long-poll so it doesn't hang until timeout
			if (session?.answerWaiter) session.answerWaiter()
			sessions.delete(signalDeleteMatch[1])
			return json(res, 200, { ok: true })
		}

		// Unknown /api/* route
		return json(res, 404, { error: "Not found" })
	}
}
