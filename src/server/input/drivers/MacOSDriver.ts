/**
 * MacOSDriver.ts
 *
 * macOS virtual input driver using CoreGraphics CGEventPost.
 * Requires: `koffi` npm package
 * Permissions: App must have Accessibility permission in System Preferences
 *   (System Preferences → Security & Privacy → Accessibility)
 */

import koffi from "koffi"
import type { VirtualInputDriver } from "../VirtualInputDriver"

const kCGHIDEventTap = 0
const kCGEventMouseMoved = 5
const kCGEventLeftMouseDown = 1
const kCGEventLeftMouseUp = 2
const kCGEventRightMouseDown = 3
const kCGEventRightMouseUp = 4
const kCGEventMiddleMouseDown = 25
const kCGEventMiddleMouseUp = 26
const kCGEventKeyDown = 10
const kCGEventKeyUp = 11
const kCGMouseButtonLeft = 0
const kCGMouseButtonRight = 1
const kCGMouseButtonCenter = 2
const kCGScrollEventUnitLine = 1

export class MacOSDriver implements VirtualInputDriver {
	private cg!: ReturnType<typeof koffi.load>
	private CGEventCreateMouseEvent!: koffi.IKoffiRegisteredCallback
	private CGEventCreateScrollWheelEvent!: koffi.IKoffiRegisteredCallback
	private CGEventCreateKeyboardEvent!: koffi.IKoffiRegisteredCallback
	private CGEventPost!: koffi.IKoffiRegisteredCallback
	private CGEventGetLocation!: koffi.IKoffiRegisteredCallback
	private CGEventCreate!: koffi.IKoffiRegisteredCallback
	private CFRelease!: koffi.IKoffiRegisteredCallback

	async init(): Promise<void> {
		this.cg = koffi.load(
			"/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
		)

		koffi.struct("CGPoint", { x: "double", y: "double" })

		this.CGEventCreateMouseEvent = this.cg.func(
			"void* CGEventCreateMouseEvent(void*, int, CGPoint, int)",
		)
		this.CGEventCreateScrollWheelEvent = this.cg.func(
			"void* CGEventCreateScrollWheelEvent(void*, int, uint32, ...)",
		)
		this.CGEventCreateKeyboardEvent = this.cg.func(
			"void* CGEventCreateKeyboardEvent(void*, uint16, bool)",
		)
		this.CGEventPost = this.cg.func("void CGEventPost(int, void*)")
		this.CGEventGetLocation = this.cg.func("CGPoint CGEventGetLocation(void*)")
		this.CGEventCreate = this.cg.func("void* CGEventCreate(void*)")
		this.CFRelease = this.cg.func("void CFRelease(void*)")
	}

	private getCursorPos(): { x: number; y: number } {
		const ev = this.CGEventCreate(null)
		const pos = this.CGEventGetLocation(ev) as { x: number; y: number }
		this.CFRelease(ev)
		return pos
	}

	async moveMouse(dx: number, dy: number): Promise<void> {
		const pos = this.getCursorPos()
		const newPos = { x: pos.x + dx, y: pos.y + dy }
		const ev = this.CGEventCreateMouseEvent(
			null,
			kCGEventMouseMoved,
			newPos,
			kCGMouseButtonLeft,
		)
		this.CGEventPost(kCGHIDEventTap, ev)
		this.CFRelease(ev)
	}

	async mouseButton(
		button: "left" | "right" | "middle",
		press?: boolean,
	): Promise<void> {
		const pos = this.getCursorPos()
		const isRight = button === "right"
		const isMiddle = button === "middle"
		const downType = isRight
			? kCGEventRightMouseDown
			: isMiddle
				? kCGEventMiddleMouseDown
				: kCGEventLeftMouseDown
		const upType = isRight
			? kCGEventRightMouseUp
			: isMiddle
				? kCGEventMiddleMouseUp
				: kCGEventLeftMouseUp
		const btn = isRight
			? kCGMouseButtonRight
			: isMiddle
				? kCGMouseButtonCenter
				: kCGMouseButtonLeft

		if (press === undefined || press === true) {
			const down = this.CGEventCreateMouseEvent(null, downType, pos, btn)
			this.CGEventPost(kCGHIDEventTap, down)
			this.CFRelease(down)
		}
		if (press === undefined || press === false) {
			const up = this.CGEventCreateMouseEvent(null, upType, pos, btn)
			this.CGEventPost(kCGHIDEventTap, up)
			this.CFRelease(up)
		}
	}

	async scroll(dx: number, dy: number): Promise<void> {
		if (dy !== 0) {
			const ev = this.CGEventCreateScrollWheelEvent(
				null,
				kCGScrollEventUnitLine,
				1,
				-Math.round(dy),
			)
			this.CGEventPost(kCGHIDEventTap, ev)
			this.CFRelease(ev)
		}
		if (dx !== 0) {
			// Horizontal scroll uses wheel2
			const ev = this.CGEventCreateScrollWheelEvent(
				null,
				kCGScrollEventUnitLine,
				2,
				0,
				Math.round(dx),
			)
			this.CGEventPost(kCGHIDEventTap, ev)
			this.CFRelease(ev)
		}
	}

	async keyTap(keyCode: number): Promise<void> {
		const down = this.CGEventCreateKeyboardEvent(null, keyCode, true)
		const up = this.CGEventCreateKeyboardEvent(null, keyCode, false)
		this.CGEventPost(kCGHIDEventTap, down)
		this.CGEventPost(kCGHIDEventTap, up)
		this.CFRelease(down)
		this.CFRelease(up)
	}

	async keyPress(keyCode: number, press: boolean): Promise<void> {
		const ev = this.CGEventCreateKeyboardEvent(null, keyCode, press)
		this.CGEventPost(kCGHIDEventTap, ev)
		this.CFRelease(ev)
	}

	async typeText(text: string): Promise<void> {
		for (const char of text) {
			const code = char.charCodeAt(0)
			await this.keyTap(code)
		}
	}

	async cleanup(): Promise<void> {
		// CoreGraphics has no explicit cleanup
	}
}
