/**
 * src/server/httpApi.ts
 *
 * HTTP REST API handlers — replaces WebSocket one-shot messages.
 *
 * Endpoints registered in vite.config.ts via server.middlewares.use():
 *
 *   GET  /api/ip             → { ip: string }
 *   POST /api/token          → { token: string }        (localhost only)
 *   POST /api/config         → { ok: true }             (localhost only)
 *
 * WebRTC signalling (used by useWebRTCProvider + useWebRTCMirror):
 *   POST /api/signal         → { sessionId, answer?, candidates? }
 *   GET  /api/signal/:id     → { offer, candidates }
 *   POST /api/signal/:id/ice → { ok: true }
 *   DELETE /api/signal/:id   → { ok: true }
 */
import fs from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { generateToken, getActiveToken, isKnownToken, storeToken } from "./tokenStore"
import { getLocalIp } from "./getLocalIp"

// ─── helpers ────────────────────────────────────────────────────────────────

function isLocalhost(req: IncomingMessage): boolean {
	const addr = req.socket.remoteAddress
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

function json(res: ServerResponse, status: number, data: unknown) {
	const body = JSON.stringify(data)
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body),
		"Access-Control-Allow-Origin": "*",
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
// Long-poll pattern: GET /api/signal/:id holds the request open for up to
// POLL_TIMEOUT_MS waiting for the answer.  This avoids polling loops on the
// provider side.

const POLL_TIMEOUT_MS = 15_000
const SESSION_TTL_MS  = 60_000

// SDP / ICE shapes — plain JSON objects passed through opaquely.
// We define local interfaces to avoid conflicts with browser DOM globals that
// are not available in the Node.js server context.
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
	// ICE candidates accumulated from the provider (desktop → viewer)
	providerIce:  IceCandidateInit[]
	// ICE candidates accumulated from the viewer (phone → provider)
	viewerIce:    IceCandidateInit[]
	// Resolve fn of a waiting long-poll request (provider side)
	answerWaiter: ((answer: SdpInit) => void) | null
	createdAt:    number
}

const sessions = new Map<string, SignalSession>()

// Prune sessions older than SESSION_TTL_MS
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
					if (key === "frontendPort" || key === "inputThrottleMs") {
						const n = Number(body[key])
						if (!Number.isFinite(n) || n < 1) {
							return json(res, 400, { error: `Invalid value for ${key}` })
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
			// Auth: require a valid token for remote callers
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
		// Viewer polls for the offer.  Provider long-polls for the answer.
		const signalGetMatch = path.match(/^\/api\/signal\/([^/]+)$/)
		if (req.method === "GET" && signalGetMatch) {
			const sessionId = signalGetMatch[1]
			const token = url.searchParams.get("token")
			if (!isLocalhost(req) && (!token || !isKnownToken(token))) {
				return unauthorized(res)
			}
			const session = sessions.get(sessionId)
			if (!session) return json(res, 404, { error: "Session not found" })

			const role = url.searchParams.get("role") // "viewer" or "provider"

			if (role === "provider") {
				// Provider is waiting for the viewer's answer (long-poll)
				if (session.answer) {
					return json(res, 200, { answer: session.answer, ice: session.viewerIce })
				}
				// Hold the request open
				await new Promise<void>((resolve) => {
					const timeout = setTimeout(() => {
						session.answerWaiter = null
						resolve()
					}, POLL_TIMEOUT_MS)
					session.answerWaiter = (_answer) => {
						clearTimeout(timeout)
						session.answerWaiter = null
						resolve()
						// answer is already stored by the POST /api/signal/:id/answer handler
					}
				})
				if (session.answer) {
					return json(res, 200, { answer: session.answer, ice: session.viewerIce })
				}
				return json(res, 408, { error: "Timeout waiting for answer" })
			}

			// Viewer: just return the offer + any provider ICE candidates
			return json(res, 200, { offer: session.offer, ice: session.providerIce })
		}

		// ── POST /api/signal/:id/answer ────────────────────────────────────────
		// Viewer posts its SDP answer.
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
			session.answer = body.answer
			// Wake up the waiting provider long-poll if any
			if (session.answerWaiter) session.answerWaiter(body.answer)
			return json(res, 200, { ok: true })
		}

		// ── POST /api/signal/:id/ice ───────────────────────────────────────────
		// Either side trickles ICE candidates.
		// Query param `role=provider` or `role=viewer` identifies the sender.
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
			sessions.delete(signalDeleteMatch[1])
			return json(res, 200, { ok: true })
		}

		// Not an API route — pass through to Vite / Nitro
		next()
	}
}
