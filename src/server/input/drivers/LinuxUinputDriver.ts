/**
 * LinuxUinputDriver.ts
 *
 * Linux virtual input driver using /dev/uinput.
 * Works on BOTH X11 and Wayland — events enter the kernel input pipeline
 * before the compositor reads them, so no compositor cooperation is needed.
 *
 * Requires: `koffi` npm package
 * Permissions: user must be in the `input` group, or run as root.
 *   sudo usermod -aG input $USER   (then re-login)
 */

import koffi from "koffi"
import type { VirtualInputDriver } from "../VirtualInputDriver"

// ── uinput constants ─────────────────────────────────────────────────────────
const O_WRONLY = 1
const O_NONBLOCK = 2048

const EV_SYN = 0x00
const EV_KEY = 0x01
const EV_REL = 0x02

const REL_X = 0x00
const REL_Y = 0x01
const REL_WHEEL = 0x08
const REL_HWHEEL = 0x06

const BTN_LEFT = 0x110
const BTN_RIGHT = 0x111
const BTN_MIDDLE = 0x112

const KEY_LEFTCTRL = 0x1d
const KEY_LEFTSHIFT = 0x2a
const KEY_LEFTALT = 0x38
const KEY_LEFTMETA = 0x7d

const UI_SET_EVBIT = 0x40045564
const UI_SET_RELBIT = 0x40045566
const UI_SET_KEYBIT = 0x40045565
const UI_DEV_SETUP = 0x405c5503
const UI_DEV_CREATE = 0x00005501
const UI_DEV_DESTROY = 0x00005502

export class LinuxUinputDriver implements VirtualInputDriver {
	private fd = -1
	private libc!: ReturnType<typeof koffi.load>
	private c_write!: koffi.IKoffiRegisteredCallback
	private c_ioctl!: koffi.IKoffiRegisteredCallback

	async init(): Promise<void> {
		this.libc = koffi.load("libc.so.6")

		const c_open = this.libc.func("int open(const char*, int)")
		this.c_write = this.libc.func("ssize_t write(int, const void*, size_t)")
		this.c_ioctl = this.libc.func("int ioctl(int, unsigned long, ...)")
		const c_close = this.libc.func("int close(int)")

		this.fd = c_open("/dev/uinput", O_WRONLY | O_NONBLOCK)
		if (this.fd < 0) {
			throw new Error(
				"Cannot open /dev/uinput.\n" +
					"Fix: sudo usermod -aG input $USER  (then re-login), or run as root.",
			)
		}

		// Register capability bits
		for (const evbit of [EV_REL, EV_KEY, EV_SYN]) {
			this.c_ioctl(this.fd, UI_SET_EVBIT, evbit)
		}
		for (const relbit of [REL_X, REL_Y, REL_WHEEL, REL_HWHEEL]) {
			this.c_ioctl(this.fd, UI_SET_RELBIT, relbit)
		}
		for (const btn of [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE]) {
			this.c_ioctl(this.fd, UI_SET_KEYBIT, btn)
		}
		// Common modifier keys
		for (const key of [
			KEY_LEFTCTRL,
			KEY_LEFTSHIFT,
			KEY_LEFTALT,
			KEY_LEFTMETA,
		]) {
			this.c_ioctl(this.fd, UI_SET_KEYBIT, key)
		}

		// Device setup: name + bus type
		const setupBuf = Buffer.alloc(92) // sizeof(uinput_setup)
		const name = "Rein Virtual Pointer"
		setupBuf.write(name, 4, "ascii") // name starts at offset 4 after id
		setupBuf.writeUInt16LE(0x03, 0) // BUS_USB
		setupBuf.writeUInt16LE(0x1234, 2) // vendor
		this.c_ioctl(this.fd, UI_DEV_SETUP, setupBuf)
		this.c_ioctl(this.fd, UI_DEV_CREATE, 0)
	}

	private emit(type: number, code: number, value: number): void {
		// struct input_event: timeval(16 bytes) + type(2) + code(2) + value(4) = 24 bytes
		const ev = Buffer.alloc(24)
		ev.writeUInt16LE(type, 16)
		ev.writeUInt16LE(code, 18)
		ev.writeInt32LE(value, 20)
		this.c_write(this.fd, ev, ev.length)
	}

	private syn(): void {
		this.emit(EV_SYN, 0, 0)
	}

	async moveMouse(dx: number, dy: number): Promise<void> {
		this.emit(EV_REL, REL_X, Math.round(dx))
		this.emit(EV_REL, REL_Y, Math.round(dy))
		this.syn()
	}

	async mouseButton(
		button: "left" | "right" | "middle",
		press?: boolean,
	): Promise<void> {
		const btn =
			button === "right"
				? BTN_RIGHT
				: button === "middle"
					? BTN_MIDDLE
					: BTN_LEFT
		if (press === undefined) {
			// full click
			this.emit(EV_KEY, btn, 1)
			this.syn()
			this.emit(EV_KEY, btn, 0)
			this.syn()
		} else {
			this.emit(EV_KEY, btn, press ? 1 : 0)
			this.syn()
		}
	}

	async scroll(dx: number, dy: number): Promise<void> {
		if (dy !== 0) {
			this.emit(EV_REL, REL_WHEEL, -Math.round(dy))
			this.syn()
		}
		if (dx !== 0) {
			this.emit(EV_REL, REL_HWHEEL, Math.round(dx))
			this.syn()
		}
	}

	async keyTap(keyCode: number): Promise<void> {
		this.emit(EV_KEY, keyCode, 1)
		this.syn()
		this.emit(EV_KEY, keyCode, 0)
		this.syn()
	}

	async keyPress(keyCode: number, press: boolean): Promise<void> {
		this.emit(EV_KEY, keyCode, press ? 1 : 0)
		this.syn()
	}

	async typeText(_text: string): Promise<void> {
		// Text typing via uinput requires X keysym mapping.
		// For now, delegate to xdotool for text if available.
		throw new Error("typeText not yet implemented for LinuxUinputDriver")
	}

	async cleanup(): Promise<void> {
		if (this.fd >= 0) {
			this.c_ioctl(this.fd, UI_DEV_DESTROY, 0)
			this.libc.func("int close(int)")(this.fd)
			this.fd = -1
		}
	}
}
