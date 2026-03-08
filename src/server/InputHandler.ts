import { Key, keyboard } from "@nut-tree-fork/nut-js"
import { KEY_MAP } from "./KeyMap"
import { createVirtualInput, type VirtualInputDriver } from "./VirtualInput"
import os from "node:os"

export interface InputMessage {
	type:
		| "move"
		| "paste"
		| "copy"
		| "click"
		| "scroll"
		| "key"
		| "text"
		| "zoom"
		| "combo"
	dx?: number
	dy?: number
	button?: "left" | "right" | "middle"
	press?: boolean
	key?: string
	keys?: string[]
	text?: string
	delta?: number
}

export class InputHandler {
	private lastMoveTime = 0
	private lastScrollTime = 0
	private pendingMove: InputMessage | null = null
	private pendingScroll: InputMessage | null = null
	private moveTimer: ReturnType<typeof setTimeout> | null = null
	private scrollTimer: ReturnType<typeof setTimeout> | null = null
	private throttleMs: number
	private modifier: Key
	private vi: VirtualInputDriver

	constructor(throttleMs = 8) {
		this.modifier = os.platform() === "darwin" ? Key.LeftSuper : Key.LeftControl
		this.throttleMs = throttleMs
		// Initialise the virtual input driver for this platform.
		// move / click / scroll bypass NutJS entirely.
		this.vi = createVirtualInput()
		this.vi.init()
	}

	setThrottleMs(ms: number) {
		this.throttleMs = ms
	}

	/** Release the virtual input device (call on server shutdown). */
	cleanup() {
		this.vi.cleanup()
	}

	private isFiniteNumber(value: unknown): value is number {
		return typeof value === "number" && Number.isFinite(value)
	}

	private clamp(value: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, value))
	}

	async handleMessage(msg: InputMessage) {
		if (msg.text && typeof msg.text === "string" && msg.text.length > 500) {
			msg.text = msg.text.substring(0, 500)
		}

		const MAX_COORD = 2000
		if (this.isFiniteNumber(msg.dx)) {
			msg.dx = this.clamp(msg.dx, -MAX_COORD, MAX_COORD)
		} else {
			msg.dx = 0
		}
		if (this.isFiniteNumber(msg.dy)) {
			msg.dy = this.clamp(msg.dy, -MAX_COORD, MAX_COORD)
		} else {
			msg.dy = 0
		}
		if (this.isFiniteNumber(msg.delta)) {
			msg.delta = this.clamp(msg.delta, -MAX_COORD, MAX_COORD)
		} else {
			msg.delta = 0
		}

		// Throttling: limit high-frequency events (configurable via inputThrottleMs)
		if (msg.type === "move") {
			const now = Date.now()
			if (now - this.lastMoveTime < this.throttleMs) {
				this.pendingMove = msg
				if (!this.moveTimer) {
					this.moveTimer = setTimeout(() => {
						this.moveTimer = null
						if (this.pendingMove) {
							const pending = this.pendingMove
							this.pendingMove = null
							this.handleMessage(pending).catch((err) => {
								console.error("Error processing pending move event:", err)
							})
						}
					}, this.throttleMs)
				}
				return
			}
			this.lastMoveTime = now
		} else if (msg.type === "scroll") {
			const now = Date.now()
			if (now - this.lastScrollTime < this.throttleMs) {
				this.pendingScroll = msg
				if (!this.scrollTimer) {
					this.scrollTimer = setTimeout(() => {
						this.scrollTimer = null
						if (this.pendingScroll) {
							const pending = this.pendingScroll
							this.pendingScroll = null
							this.handleMessage(pending).catch((err) => {
								console.error("Error processing pending scroll event:", err)
							})
						}
					}, this.throttleMs)
				}
				return
			}
			this.lastScrollTime = now
		}

		switch (msg.type) {
			// ── trackpad inputs via VirtualInput (no NutJS) ──────────────────────
			case "move":
				if (
					typeof msg.dx === "number" &&
					typeof msg.dy === "number" &&
					Number.isFinite(msg.dx) &&
					Number.isFinite(msg.dy)
				) {
					try {
						this.vi.moveMouse(Math.round(msg.dx), Math.round(msg.dy))
					} catch (err) {
						console.error("Move event failed:", err)
					}
				}
				break

			case "click": {
				const VALID_BUTTONS = ["left", "right", "middle"] as const
				if (msg.button && VALID_BUTTONS.includes(msg.button)) {
					try {
						if (msg.button === "left") {
							this.vi.leftClick()
						} else if (msg.button === "right") {
							this.vi.rightClick()
						} else {
							this.vi.middleClick()
						}
					} catch (err) {
						console.error("Click event failed:", err)
					}
				}
				break
			}

			case "scroll": {
				const MAX_SCROLL = 100
				try {
					// Vertical
					if (this.isFiniteNumber(msg.dy) && Math.round(msg.dy) !== 0) {
						const ticks = this.clamp(
							Math.round(msg.dy),
							-MAX_SCROLL,
							MAX_SCROLL,
						)
						this.vi.scrollV(ticks)
					}
					// Horizontal
					if (this.isFiniteNumber(msg.dx) && Math.round(msg.dx) !== 0) {
						const ticks = this.clamp(
							Math.round(msg.dx),
							-MAX_SCROLL,
							MAX_SCROLL,
						)
						this.vi.scrollH(ticks)
					}
				} catch (err) {
					console.error("Scroll event failed:", err)
				}
				break
			}

			// ── keyboard / clipboard — still via NutJS (out of PoC scope) ─────────
			case "copy": {
				try {
					await keyboard.pressKey(this.modifier, Key.C)
				} catch (err) {
					console.warn("Error while copying:", err)
				} finally {
					await Promise.allSettled([
						keyboard.releaseKey(Key.C),
						keyboard.releaseKey(this.modifier),
					])
				}
				break
			}
			case "paste": {
				try {
					await keyboard.pressKey(this.modifier, Key.V)
				} catch (err) {
					console.warn("Error while pasting:", err)
				} finally {
					await Promise.allSettled([
						keyboard.releaseKey(Key.V),
						keyboard.releaseKey(this.modifier),
					])
				}
				break
			}

			case "zoom":
				if (this.isFiniteNumber(msg.delta) && msg.delta !== 0) {
					const sensitivityFactor = 0.5
					const MAX_ZOOM_STEP = 5

					const scaledDelta =
						Math.sign(msg.delta) *
						Math.min(Math.abs(msg.delta) * sensitivityFactor, MAX_ZOOM_STEP)

					const amount = Math.round(-scaledDelta)

					if (amount !== 0) {
						await keyboard.pressKey(Key.LeftControl)
						try {
							this.vi.scrollV(-amount)
						} finally {
							await keyboard.releaseKey(Key.LeftControl)
						}
					}
				}
				break

			case "key":
				if (msg.key && typeof msg.key === "string" && msg.key.length <= 50) {
					console.log(`Processing key: ${msg.key}`)
					const nutKey = KEY_MAP[msg.key.toLowerCase()]

					try {
						if (nutKey !== undefined) {
							await keyboard.pressKey(nutKey)
							await keyboard.releaseKey(nutKey)
						} else if (msg.key === " " || msg.key?.toLowerCase() === "space") {
							const spaceKey = KEY_MAP.space
							await keyboard.pressKey(spaceKey)
							await keyboard.releaseKey(spaceKey)
						} else if (msg.key.length === 1) {
							await keyboard.type(msg.key)
						} else {
							console.log(`Unmapped key: ${msg.key}`)
						}
					} catch (err) {
						console.warn("Key press failed:", err)
						// ensure release just in case
						if (nutKey !== undefined)
							await keyboard.releaseKey(nutKey).catch(() => {})
						if (msg.key === " " || msg.key?.toLowerCase() === "space")
							await keyboard.releaseKey(KEY_MAP.space).catch(() => {})
					}
				}
				break

			case "combo":
				if (
					msg.keys &&
					Array.isArray(msg.keys) &&
					msg.keys.length > 0 &&
					msg.keys.length <= 10
				) {
					const nutKeys: (Key | string)[] = []

					for (const k of msg.keys) {
						const lowerKey = k.toLowerCase()
						const nutKey = KEY_MAP[lowerKey]

						if (nutKey !== undefined) {
							nutKeys.push(nutKey)
						} else if (lowerKey.length === 1) {
							nutKeys.push(lowerKey)
						} else {
							console.warn(`Unknown key in combo: ${k}`)
						}
					}

					if (nutKeys.length === 0) {
						console.error("No valid keys in combo")
						return
					}

					console.log("Pressing keys:", nutKeys)
					const pressedKeys: Key[] = []

					try {
						for (const k of nutKeys) {
							if (typeof k === "string") {
								await keyboard.type(k)
							} else {
								await keyboard.pressKey(k)
								pressedKeys.push(k)
							}
						}

						await new Promise((resolve) => setTimeout(resolve, 10))
					} catch (err) {
						console.error("Combo execution failed:", err)
					} finally {
						const releasePromises = pressedKeys
							.reverse()
							.map((k) => keyboard.releaseKey(k))
						await Promise.allSettled(releasePromises)
					}

					console.log(`Combo complete: ${msg.keys.join("+")}`)
				}
				break

			case "text":
				if (msg.text && typeof msg.text === "string") {
					try {
						await keyboard.type(msg.text)
					} catch (err) {
						console.error("Failed to type text:", err)
					}
				}
				break
		}
	}
}
