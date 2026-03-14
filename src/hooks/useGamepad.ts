"use client"

import { useCallback, useRef } from "react"
import type { GamepadState } from "@/components/Gamepad/GamepadUI"
import { useRemoteConnection } from "../hooks/useRemoteConnection"

const THROTTLE_MS = 16

export const useGamepad = () => {
	const { send } = useRemoteConnection()
	const lastSendTime = useRef(0)
	const previousState = useRef<GamepadState | null>(null)
	const pendingState = useRef<GamepadState | null>(null)
	const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	const sendGamepadState = useCallback(
		(state: GamepadState) => {
			const now = Date.now()
			const elapsed = now - lastSendTime.current

			// Diff-check: skip if nothing changed
			if (previousState.current) {
				const prev = previousState.current
				const hasChanges =
					state.leftStick.x !== prev.leftStick.x ||
					state.leftStick.y !== prev.leftStick.y ||
					state.rightStick.x !== prev.rightStick.x ||
					state.rightStick.y !== prev.rightStick.y ||
					Object.keys(state.buttons).some(
						(key) =>
							state.buttons[key as keyof typeof state.buttons] !==
							prev.buttons[key as keyof typeof prev.buttons],
					)

				if (!hasChanges) {
					return
				}
			}

			if (elapsed >= THROTTLE_MS) {
				// Not throttled — send immediately
				lastSendTime.current = now
				previousState.current = JSON.parse(JSON.stringify(state))
				send({
					type: "gamepad",
					state: {
						leftStick: state.leftStick,
						rightStick: state.rightStick,
						buttons: state.buttons,
					},
				})
			} else {
				// Throttled — store latest snapshot; schedule a single flush if needed
				pendingState.current = state
				if (!pendingTimer.current) {
					const delay = THROTTLE_MS - elapsed
					pendingTimer.current = setTimeout(() => {
						pendingTimer.current = null
						const pending = pendingState.current
						pendingState.current = null
						if (pending) {
							lastSendTime.current = Date.now()
							previousState.current = JSON.parse(JSON.stringify(pending))
							send({
								type: "gamepad",
								state: {
									leftStick: pending.leftStick,
									rightStick: pending.rightStick,
									buttons: pending.buttons,
								},
							})
						}
					}, delay)
				}
			}
		},
		[send],
	)

	return { sendGamepadState }
}
