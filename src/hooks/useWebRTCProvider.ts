"use client"

/**
 * useWebRTCProvider — PoC for issue #296
 *
 * Replaces the canvas/WebSocket binary pipeline in useCaptureProvider.ts with
 * a native WebRTC MediaTrack.  The desktop captures the screen with
 * getDisplayMedia(), attaches the track to an RTCPeerConnection, and
 * exchanges SDP + ICE candidates with the viewer via the HTTP signalling API
 * (src/server/httpApi.ts).
 *
 * Flow:
 *   1. getDisplayMedia() → MediaStream
 *   2. pc.createDataChannel("input") — must be before createOffer so SDP includes it
 *   3. POST /api/signal  → sessionId  (SDP offer)
 *   4. Long-poll GET /api/signal/:id?role=provider → SDP answer + ICE
 *   5. setRemoteDescription(answer) + add ICE candidates
 *   6. Trickle own ICE candidates via POST /api/signal/:id/ice
 *   7. P2P video flows directly to the viewer — server never touches frames
 *
 * Benefits over canvas pipeline:
 *   - Hardware H.264/VP9/AV1 encoding (browser codec stack)
 *   - Adaptive bitrate + frame rate
 *   - No server relay of video data
 *   - Works with Wayland portals automatically
 */
import { useCallback, useEffect, useRef, useState } from "react"

function getToken(): string {
	try {
		return localStorage.getItem("rein_auth_token") ?? ""
	} catch {
		return ""
	}
}

/** Returns "?token=…" if a token exists, otherwise "". */
function tokenParam(): string {
	const t = getToken()
	return t ? `?token=${encodeURIComponent(t)}` : ""
}

/**
 * Appends a token param to a URL that already has a query string.
 * e.g. appendToken("/api/signal/id?role=provider") → "…&token=xxx"
 */
function appendToken(url: string): string {
	const t = getToken()
	return t ? `${url}&token=${encodeURIComponent(t)}` : url
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
	return fetch(path, {
		headers: { "Content-Type": "application/json", ...init?.headers },
		...init,
	})
}

export function useWebRTCProvider() {
	const [isSharing, setIsSharing] = useState(false)
	const pcRef        = useRef<RTCPeerConnection | null>(null)
	const streamRef    = useRef<MediaStream | null>(null)
	const sessionIdRef = useRef<string | null>(null)

	const stopSharing = useCallback(async () => {
		if (streamRef.current) {
			for (const t of streamRef.current.getTracks()) t.stop()
			streamRef.current = null
		}
		if (pcRef.current) {
			pcRef.current.close()
			pcRef.current = null
		}
		if (sessionIdRef.current) {
			// Best-effort cleanup — wake the long-poll and remove the session
			await apiFetch(`/api/signal/${sessionIdRef.current}${tokenParam()}`, {
				method: "DELETE",
			}).catch(() => {})
			sessionIdRef.current = null
		}
		setIsSharing(false)
	}, [])

	const startSharing = useCallback(async (): Promise<boolean> => {
		try {
			// 1. Capture the screen
			const stream = await navigator.mediaDevices.getDisplayMedia({
				video: true,
				audio: false,
			})
			streamRef.current = stream

			const videoTracks = stream.getVideoTracks()
			if (videoTracks.length === 0) {
				// No video track returned — clean up and bail
				stream.getTracks().forEach((t) => t.stop())
				return false
			}

			// 2. Create RTCPeerConnection (no STUN/TURN needed for LAN)
			const pc = new RTCPeerConnection({ iceServers: [] })
			pcRef.current = pc

			// Create the input DataChannel BEFORE createOffer() so the SDP
			// includes a data section — otherwise ondatachannel never fires on
			// the viewer side.
			pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 })

			// Add video tracks to the peer connection
			for (const track of videoTracks) {
				pc.addTrack(track, stream)
			}

			// Trickle ICE candidates to the signalling server
			pc.onicecandidate = ({ candidate }) => {
				if (!candidate || !sessionIdRef.current) return
				apiFetch(
					`/api/signal/${sessionIdRef.current}/ice${tokenParam()}`,
					{
						method: "POST",
						body: JSON.stringify({ candidate, role: "provider" }),
					},
				).catch(() => {})
			}

			// Handle stream end (user clicks browser "Stop Sharing")
			videoTracks[0].onended = () => {
				stopSharing()
			}

			// 3. Create SDP offer
			const offer = await pc.createOffer()
			await pc.setLocalDescription(offer)

			// 4. POST offer to signalling server → get sessionId
			const offerRes = await apiFetch(`/api/signal${tokenParam()}`, {
				method: "POST",
				body: JSON.stringify({ offer }),
			})
			if (!offerRes.ok) throw new Error("Signalling: failed to post offer")
			const { sessionId } = (await offerRes.json()) as { sessionId: string }
			sessionIdRef.current = sessionId

			setIsSharing(true)

			// 5. Long-poll for the viewer's answer (background task)
			;(async () => {
				try {
					const pollUrl = appendToken(`/api/signal/${sessionId}?role=provider`)
					const answerRes = await apiFetch(pollUrl)
					if (!answerRes.ok) return
					const { answer, ice } = (await answerRes.json()) as {
						answer: RTCSessionDescriptionInit
						ice: RTCIceCandidateInit[]
					}
					await pc.setRemoteDescription(new RTCSessionDescription(answer))
					for (const c of ice ?? []) {
						await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
					}
				} catch (e) {
					console.error("[WebRTC provider] answer poll failed:", e)
				}
			})()

			return true
		} catch (err) {
			console.error("[WebRTC provider] startSharing failed:", err)
			await stopSharing()
			return false
		}
	}, [stopSharing])

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			stopSharing()
		}
	}, [stopSharing])

	return { isSharing, startSharing, stopSharing }
}
