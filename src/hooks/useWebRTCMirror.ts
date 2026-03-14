"use client"

/**
 * useWebRTCMirror — PoC for issue #296
 *
 * Replaces useMirrorStream.ts (canvas + binary WebSocket blobs) with a native
 * WebRTC viewer.  The phone side fetches the SDP offer from the signalling
 * server, creates an answer, and receives the desktop screen as a live
 * MediaStream that plays in a <video> element at full browser-decoded quality.
 *
 * Additionally, this hook establishes a WebRTC DataChannel for sending input
 * events (mouse, keyboard, scroll) back to the desktop — replacing the
 * WebSocket JSON input messages.  This eliminates TCP head-of-line blocking:
 * DataChannels use SCTP/DTLS over UDP, so a dropped mouse-move packet does
 * not block the next one.
 *
 * Flow:
 *   1. GET /api/signal/:sessionId?role=viewer → SDP offer + ICE candidates
 *   2. setRemoteDescription(offer)
 *   3. createAnswer() → setLocalDescription()
 *   4. POST /api/signal/:sessionId/answer
 *   5. Trickle ICE via POST /api/signal/:sessionId/ice?role=viewer
 *   6. pc.ontrack → attach MediaStream to <video> element
 *   7. DataChannel "input" opens → route input events over it
 */
import { useCallback, useEffect, useRef, useState } from "react"

export interface WebRTCMirrorState {
	/** true once the first video track arrives */
	hasStream: boolean
	/** The live MediaStream, attach to <video>.srcObject */
	stream: MediaStream | null
	/** Send an input event over the DataChannel (falls back to WebSocket) */
	sendInput: (msg: unknown) => void
	/** true when the DataChannel is open and ready */
	dataChannelOpen: boolean
}

function getToken(): string {
	try {
		return localStorage.getItem("rein_auth_token") ?? ""
	} catch {
		return ""
	}
}

function tokenSuffix(prefix: "?" | "&"): string {
	const t = getToken()
	return t ? `${prefix}token=${encodeURIComponent(t)}` : ""
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
	return fetch(path, {
		headers: { "Content-Type": "application/json", ...init?.headers },
		...init,
	})
}

interface UseWebRTCMirrorOptions {
	sessionId: string
	/** Fallback: WebSocket send fn used when DataChannel is not yet open */
	wsSend?: (msg: unknown) => void
}

export function useWebRTCMirror({
	sessionId,
	wsSend,
}: UseWebRTCMirrorOptions): WebRTCMirrorState {
	const [hasStream, setHasStream] = useState(false)
	const [stream, setStream] = useState<MediaStream | null>(null)
	const [dataChannelOpen, setDataChannelOpen] = useState(false)

	const pcRef  = useRef<RTCPeerConnection | null>(null)
	const dcRef  = useRef<RTCDataChannel | null>(null)
	// Track mounted state to avoid setState on unmounted component
	const mountedRef = useRef(true)

	const sendInput = useCallback(
		(msg: unknown) => {
			// Prefer DataChannel (UDP-like, no HoL blocking) over WebSocket
			if (dcRef.current?.readyState === "open") {
				dcRef.current.send(JSON.stringify(msg))
			} else if (wsSend) {
				wsSend(msg)
			}
		},
		[wsSend],
	)

	useEffect(() => {
		mountedRef.current = true
		if (!sessionId) return

		const abortCtrl = new AbortController()
		const { signal } = abortCtrl

		const pc = new RTCPeerConnection({ iceServers: [] })
		pcRef.current = pc

		// ── DataChannel for input events ──────────────────────────────────────
		pc.ondatachannel = (event) => {
			const dc = event.channel
			dcRef.current = dc
			dc.onopen  = () => { if (mountedRef.current) setDataChannelOpen(true)  }
			dc.onclose = () => { if (mountedRef.current) setDataChannelOpen(false) }
		}

		// ── Incoming video track → attach to state ────────────────────────────
		pc.ontrack = (event) => {
			if (!mountedRef.current) return
			const ms = event.streams[0] ?? new MediaStream([event.track])
			setStream(ms)
			setHasStream(true)
		}

		// ── Trickle ICE from viewer to provider ───────────────────────────────
		pc.onicecandidate = ({ candidate }) => {
			if (!candidate || signal.aborted) return
			apiFetch(`/api/signal/${sessionId}/ice${tokenSuffix("?")}`, {
				method: "POST",
				body: JSON.stringify({ candidate, role: "viewer" }),
				signal,
			}).catch(() => {})
		}

		;(async () => {
			try {
				// 1. Fetch the offer + any provider ICE candidates
				const offerRes = await apiFetch(
					`/api/signal/${sessionId}?role=viewer${tokenSuffix("&")}`,
					{ signal },
				)
				if (!offerRes.ok || signal.aborted) return
				const { offer, ice: providerIce } = (await offerRes.json()) as {
					offer: RTCSessionDescriptionInit
					ice: RTCIceCandidateInit[]
				}

				// 2. Apply offer
				await pc.setRemoteDescription(new RTCSessionDescription(offer))
				if (signal.aborted) return

				// 3. Create and apply answer
				const answer = await pc.createAnswer()
				await pc.setLocalDescription(answer)
				if (signal.aborted) return

				// 4. Post answer to signalling server
				await apiFetch(`/api/signal/${sessionId}/answer${tokenSuffix("?")}`, {
					method: "POST",
					body: JSON.stringify({ answer }),
					signal,
				})

				// 5. Apply any ICE candidates that arrived before the answer
				for (const c of providerIce ?? []) {
					await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
				}
			} catch (e) {
				// AbortError is expected on cleanup — suppress it
				if (e instanceof Error && e.name === "AbortError") return
				if (mountedRef.current) console.error("[WebRTC mirror] setup failed:", e)
			}
		})()

		return () => {
			mountedRef.current = false
			abortCtrl.abort()
			if (dcRef.current) {
				dcRef.current.close()
				dcRef.current = null
			}
			pc.close()
			pcRef.current = null
		}
	}, [sessionId])

	// Reset state when sessionId changes or on unmount
	useEffect(() => {
		return () => {
			mountedRef.current = false
			setHasStream(false)
			setStream(null)
			setDataChannelOpen(false)
		}
	}, [sessionId])

	return { hasStream, stream, sendInput, dataChannelOpen }
}
