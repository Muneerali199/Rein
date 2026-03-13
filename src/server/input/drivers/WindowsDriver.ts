/**
 * WindowsDriver.ts
 *
 * Windows virtual input driver using user32.dll SendInput.
 * Events are injected at the Win32 HARDWARE_EVENT level — identical to real
 * hardware. Works in all sessions including secure desktop (UAC prompts).
 *
 * Requires: `koffi` npm package
 */

import koffi from "koffi"
import type { VirtualInputDriver } from "../VirtualInputDriver"

// ── Win32 constants ──────────────────────────────────────────────────────────
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_RIGHTDOWN = 0x0008
const MOUSEEVENTF_RIGHTUP = 0x0010
const MOUSEEVENTF_MIDDLEDOWN = 0x0020
const MOUSEEVENTF_MIDDLEUP = 0x0040
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_HWHEEL = 0x1000
const WHEEL_DELTA = 120
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004

export class WindowsDriver implements VirtualInputDriver {
	private user32!: ReturnType<typeof koffi.load>
	private SendInput!: koffi.IKoffiRegisteredCallback
	private GetCursorPos!: koffi.IKoffiRegisteredCallback
	private SetCursorPos!: koffi.IKoffiRegisteredCallback
	private INPUT_size = 0

	async init(): Promise<void> {
		this.user32 = koffi.load("user32.dll")

		const POINT = koffi.struct("POINT", { x: "long", y: "long" })
		const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
			dx: "long",
			dy: "long",
			mouseData: "uint32",
			dwFlags: "uint32",
			time: "uint32",
			dwExtraInfo: "uintptr",
		})
		const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
			wVk: "uint16",
			wScan: "uint16",
			dwFlags: "uint32",
			time: "uint32",
			dwExtraInfo: "uintptr",
		})
		const INPUT_UNION = koffi.union("INPUT_UNION", {
			mi: MOUSEINPUT,
			ki: KEYBDINPUT,
		})
		const INPUT = koffi.struct("INPUT", { type: "uint32", u: INPUT_UNION })

		this.INPUT_size = koffi.sizeof(INPUT)

		this.SendInput = this.user32.func(
			"unsigned int __stdcall SendInput(unsigned int cInputs, INPUT* pInputs, int cbSize)",
		)
		this.GetCursorPos = this.user32.func(
			"bool __stdcall GetCursorPos(POINT* lpPoint)",
		)
		this.SetCursorPos = this.user32.func(
			"bool __stdcall SetCursorPos(int X, int Y)",
		)
	}

	private mouseInput(flags: number, data = 0) {
		return {
			type: INPUT_MOUSE,
			u: {
				mi: {
					dx: 0,
					dy: 0,
					mouseData: data,
					dwFlags: flags,
					time: 0,
					dwExtraInfo: 0,
				},
			},
		}
	}

	private keyInput(scanCode: number, flags: number) {
		return {
			type: INPUT_KEYBOARD,
			u: {
				ki: {
					wVk: 0,
					wScan: scanCode,
					dwFlags: flags,
					time: 0,
					dwExtraInfo: 0,
				},
			},
		}
	}

	async moveMouse(dx: number, dy: number): Promise<void> {
		const pt = [{ x: 0, y: 0 }]
		this.GetCursorPos(pt)
		this.SetCursorPos(pt[0].x + Math.round(dx), pt[0].y + Math.round(dy))
	}

	async mouseButton(
		button: "left" | "right" | "middle",
		press?: boolean,
	): Promise<void> {
		const downFlag =
			button === "right"
				? MOUSEEVENTF_RIGHTDOWN
				: button === "middle"
					? MOUSEEVENTF_MIDDLEDOWN
					: MOUSEEVENTF_LEFTDOWN
		const upFlag =
			button === "right"
				? MOUSEEVENTF_RIGHTUP
				: button === "middle"
					? MOUSEEVENTF_MIDDLEUP
					: MOUSEEVENTF_LEFTUP

		if (press === undefined) {
			this.SendInput(
				2,
				[this.mouseInput(downFlag), this.mouseInput(upFlag)],
				this.INPUT_size,
			)
		} else if (press) {
			this.SendInput(1, [this.mouseInput(downFlag)], this.INPUT_size)
		} else {
			this.SendInput(1, [this.mouseInput(upFlag)], this.INPUT_size)
		}
	}

	async scroll(dx: number, dy: number): Promise<void> {
		const inputs = []
		if (dy !== 0)
			inputs.push(
				this.mouseInput(MOUSEEVENTF_WHEEL, -Math.round(dy) * WHEEL_DELTA),
			)
		if (dx !== 0)
			inputs.push(
				this.mouseInput(MOUSEEVENTF_HWHEEL, Math.round(dx) * WHEEL_DELTA),
			)
		if (inputs.length) this.SendInput(inputs.length, inputs, this.INPUT_size)
	}

	async keyTap(scanCode: number): Promise<void> {
		this.SendInput(
			2,
			[
				this.keyInput(scanCode, KEYEVENTF_UNICODE),
				this.keyInput(scanCode, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
			],
			this.INPUT_size,
		)
	}

	async keyPress(scanCode: number, press: boolean): Promise<void> {
		const flags = press
			? KEYEVENTF_UNICODE
			: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
		this.SendInput(1, [this.keyInput(scanCode, flags)], this.INPUT_size)
	}

	async typeText(text: string): Promise<void> {
		for (const char of text) {
			const code = char.charCodeAt(0)
			await this.keyTap(code)
		}
	}

	async cleanup(): Promise<void> {
		// No device to destroy on Windows
	}
}
