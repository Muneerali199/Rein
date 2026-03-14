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
 *   2. POST /api/signal  → sessionId  (SDP offer)
 *   3. Long-poll GET /api/signal/:id?role=provider → SDP answer + ICE
 *   4. setRemoteDescription(answer) + add ICE candidates
 *   5. Trickle own ICE candidates via POST /api/signal/:id/ice
 *   6. P2P video flows directly to the viewer — server never touches frames
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

function tokenParam(): string {
	const t = getToken()
	return t ? `?token=${encodeURIComponent(t)}` : ""
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
	return fetch(path, {
		headers: { "Content-Type": "application/json", ...init?.headers },
		...init,
	})
}

export function useWebRTCProvider() {
	const [isSharing, setIsSharing] = useState(false)
	const pcRef     = useRef<RTCPeerConnection | null>(null)
	const streamRef = useRef<MediaStream | null>(null)
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
			// Best-effort cleanup — viewer will time-out otherwise
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

			// 2. Create RTCPeerConnection (no STUN/TURN needed for LAN)
			const pc = new RTCPeerConnection({ iceServers: [] })
			pcRef.current = pc

			// Add all video tracks to the peer connection
			for (const track of stream.getVideoTracks()) {
				pc.addTrack(track, stream)
			}

			// Trickle ICE candidates to the signalling server
			pc.onicecandidate = async ({ candidate }) => {
				if (!candidate || !sessionIdRef.current) return
				await apiFetch(
					`/api/signal/${sessionIdRef.current}/ice${tokenParam()}`,
					{
						method: "POST",
						body: JSON.stringify({ candidate, role: "provider" }),
					},
				).catch(() => {})
			}

			// Handle stream end (user clicks browser "Stop Sharing")
			stream.getVideoTracks()[0].onended = () => {
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

			// 5. Long-poll for the viewer's answer
			// This runs in the background — provider is already "sharing" by now.
			;(async () => {
				try {
					const answerRes = await apiFetch(
						`/api/signal/${sessionId}?role=provider${tokenParam() ? `&token=${getToken()}` : ""}`,
					)
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
