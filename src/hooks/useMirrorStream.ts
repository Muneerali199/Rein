"use client"

import { useEffect, useRef, useState } from "react"

export function useMirrorStream(
	wsRef: React.RefObject<WebSocket | null>,
	canvasRef: React.RefObject<HTMLCanvasElement | null>,
	status: "connecting" | "connected" | "disconnected",
) {
	const [hasFrame, setHasFrame] = useState(false)
	const frameRef = useRef<ImageBitmap | null>(null)
	const rAFRef = useRef<number | null>(null)
	const isDecoding = useRef(false)

	useEffect(() => {
		const ws = wsRef.current
		const canvas = canvasRef.current
		const renderFrame = () => {
			if (!canvas || !frameRef.current) return
			const ctx = canvas.getContext("2d", {
				alpha: false,
				desynchronized: true,
			})
			if (!ctx) return

			if (
				canvas.width !== frameRef.current.width ||
				canvas.height !== frameRef.current.height
			) {
				canvas.width = frameRef.current.width
				canvas.height = frameRef.current.height
			}

			ctx.drawImage(frameRef.current, 0, 0)
			rAFRef.current = null
		}

		if (!ws || status !== "connected") {
			setHasFrame(false)
			return
		}

		const handleMessage = async (event: MessageEvent) => {
			if (!(event.data instanceof Blob)) return

			// Frame Dropping
			if (isDecoding.current || rAFRef.current) return

			try {
				isDecoding.current = true

				const bitmap = await createImageBitmap(event.data)

				if (frameRef.current) {
					frameRef.current.close()
				}

				frameRef.current = bitmap
				setHasFrame(true)

				rAFRef.current = requestAnimationFrame(renderFrame)
			} catch (e) {
				console.error("Frame decoding error:", e)
			} finally {
				isDecoding.current = false
			}
		}

		ws.binaryType = "blob"

		ws.addEventListener("message", handleMessage)

		ws.send(JSON.stringify({ type: "start-mirror" }))

		return () => {
			ws.removeEventListener("message", handleMessage)

			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "stop-mirror" }))
			}

			if (rAFRef.current) {
				cancelAnimationFrame(rAFRef.current)
			}

			if (frameRef.current) {
				frameRef.current.close()
			}
		}
	}, [wsRef, status, canvasRef])

	return { hasFrame }
}
