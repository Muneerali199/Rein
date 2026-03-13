/**
 * VirtualInputDriver.ts
 *
 * Platform-agnostic interface for virtual input injection.
 * Each platform (Windows, Linux, macOS) provides a concrete implementation.
 *
 * This replaces @nut-tree-fork/nut-js entirely.
 * Events are injected at the kernel level — works on X11, Wayland, and all
 * Windows/macOS display configurations.
 */

export interface VirtualInputDriver {
	/** Initialise the virtual device. Must be called before any other method. */
	init(): Promise<void>
	/** Relative mouse movement in pixels */
	moveMouse(dx: number, dy: number): Promise<void>
	/** Mouse button press or release. `press=true` → down, `press=false` → up, `undefined` → full click */
	mouseButton(
		button: "left" | "right" | "middle",
		press?: boolean,
	): Promise<void>
	/** Scroll. dy > 0 = down, dy < 0 = up. dx > 0 = right, dx < 0 = left */
	scroll(dx: number, dy: number): Promise<void>
	/** Single key press + release */
	keyTap(keyCode: number): Promise<void>
	/** Key down or up */
	keyPress(keyCode: number, press: boolean): Promise<void>
	/** Type a unicode string */
	typeText(text: string): Promise<void>
	/** Clean up the virtual device on shutdown */
	cleanup(): Promise<void>
}

/**
 * Factory: returns the correct driver for the current OS at runtime.
 * Import this instead of instantiating drivers directly.
 */
export async function createVirtualInputDriver(): Promise<VirtualInputDriver> {
	switch (process.platform) {
		case "win32": {
			const { WindowsDriver } = await import("./drivers/WindowsDriver")
			return new WindowsDriver()
		}
		case "linux": {
			const { LinuxUinputDriver } = await import("./drivers/LinuxUinputDriver")
			return new LinuxUinputDriver()
		}
		case "darwin": {
			const { MacOSDriver } = await import("./drivers/MacOSDriver")
			return new MacOSDriver()
		}
		default:
			throw new Error(
				`Unsupported platform: ${process.platform}. ` +
					`Expected one of: win32, linux, darwin`,
			)
	}
}
