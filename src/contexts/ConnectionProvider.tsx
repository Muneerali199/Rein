"use client"

import type React from "react"
import { createContext, useContext, useEffect, useRef, useState } from "react"

type ConnectionStatus = "connecting" | "connected" | "disconnected"

interface ConnectionContextType {
	wsRef: React.RefObject<WebSocket | null>
	status: ConnectionStatus
	platform: string | null
	latency: number | null
	send: (msg: unknown) => void
	subscribe: (type: string, callback: (msg: unknown) => void) => () => void
}

const ConnectionContext = createContext<ConnectionContextType | null>(null)

export const useConnection = () => {
	const context = useContext(ConnectionContext)
	if (!context)
		throw new Error("useConnection must be used within ConnectionProvider")
	return context
}

export function ConnectionProvider({
	children,
}: {
	children: React.ReactNode
}) {
	const wsRef = useRef<WebSocket | null>(null)
	const [status, setStatus] = useState<ConnectionStatus>("disconnected")
	const [platform, setPlatform] = useState<string | null>(null)
	const [latency, setLatency] = useState<number | null>(null)
	const isMountedRef = useRef(true)
	const subscribersRef = useRef<Record<string, Set<(msg: unknown) => void>>>({})

	const subscribe = (type: string, callback: (msg: unknown) => void) => {
		if (!subscribersRef.current[type]) {
			subscribersRef.current[type] = new Set()
		}

		subscribersRef.current[type].add(callback)

		return () => {
			subscribersRef.current[type].delete(callback)
		}
	}

	const reconnectCountRef = useRef(0)
	const reconnectTimerRef = useRef<number | null>(null)

	useEffect(() => {
		isMountedRef.current = true
		const connect = () => {
			if (!isMountedRef.current) return

			if (reconnectTimerRef.current) {
				clearTimeout(reconnectTimerRef.current)
				reconnectTimerRef.current = null
			}

			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
			const host = window.location.host
			const urlParams = new URLSearchParams(window.location.search)
			const urlToken = urlParams.get("token")

			let storedToken: string | null = null
			try {
				storedToken = localStorage.getItem("rein_auth_token")
			} catch (_e) {
				// Restricted context (e.g. private mode)
			}

			const token = urlToken || storedToken

			if (urlToken && urlToken !== storedToken) {
				try {
					localStorage.setItem("rein_auth_token", urlToken)
				} catch (_e) {
					// Failed to store
				}
			}

			let wsUrl = `${protocol}//${host}/ws`
			if (token) {
				wsUrl += `?token=${encodeURIComponent(token)}`
			}

			if (wsRef.current) {
				wsRef.current.onopen = null
				wsRef.current.onclose = null
				wsRef.current.onerror = null
				wsRef.current.close()
			}

			setStatus("connecting")
			const socket = new WebSocket(wsUrl)

			socket.onopen = () => {
				if (isMountedRef.current) {
					setStatus("connected")
					reconnectCountRef.current = 0 // Reset on successful connect
					if (reconnectTimerRef.current) {
						clearTimeout(reconnectTimerRef.current)
						reconnectTimerRef.current = null
					}
				}
			}

			socket.onmessage = (event) => {
				if (!isMountedRef.current) return

				// Handle binary data separately (frames)
				if (event.data instanceof Blob) {
					// Relayed directly via internal listeners in hooks
					return
				}

				try {
					const msg = JSON.parse(event.data)
					if (msg.type === "connected") {
						setPlatform(msg.platform || null)
					}
					const typeSubscribers = subscribersRef.current[msg.type]
					if (typeSubscribers) {
						for (const callback of typeSubscribers) {
							callback(msg)
						}
					}
				} catch (_e) {
					// Not JSON or silent error
				}
			}

			socket.onclose = () => {
				if (isMountedRef.current) {
					setStatus("disconnected")
					// Exponential Backoff
					const delay = Math.min(
						1000 * 2 ** reconnectCountRef.current,
						30000, // Max 30s
					)
					reconnectCountRef.current += 1

					if (reconnectTimerRef.current) {
						clearTimeout(reconnectTimerRef.current)
					}
					reconnectTimerRef.current = window.setTimeout(connect, delay)
				}
			}

			socket.onerror = () => {
				socket.close()
			}

			wsRef.current = socket
		}
		connect()
		return () => {
			isMountedRef.current = false
			if (reconnectTimerRef.current) {
				clearTimeout(reconnectTimerRef.current)
				reconnectTimerRef.current = null
			}
			if (wsRef.current) {
				wsRef.current.onopen = null
				wsRef.current.onclose = null
				wsRef.current.onerror = null
				wsRef.current.close()
				wsRef.current = null
			}
		}
	}, [])

	const send = (msg: unknown) => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify(msg))
		}
	}

	// Ping/Pong heartbeat for latency measurement
	useEffect(() => {
		if (status !== "connected") {
			setLatency(null)
			return
		}
		const ws = wsRef.current
		if (!ws) return

		const handlePong = (msg: unknown) => {
			const pong = msg as { timestamp?: number }
			if (pong.timestamp) {
				setLatency(Date.now() - pong.timestamp)
			}
		}
		if (!subscribersRef.current.pong) {
			subscribersRef.current.pong = new Set()
		}
		subscribersRef.current.pong.add(handlePong)

		// Send a ping immediately, then every 2 seconds
		const sendPing = () => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(
					JSON.stringify({
						type: "ping",
						timestamp: Date.now(),
					}),
				)
			}
		}
		sendPing()
		const interval = setInterval(sendPing, 2000)

		return () => {
			subscribersRef.current.pong.delete(handlePong)
			clearInterval(interval)
		}
	}, [status])

	return (
		<ConnectionContext.Provider
			value={{ wsRef, status, platform, latency, send, subscribe }}
		>
			{children}
		</ConnectionContext.Provider>
	)
}
