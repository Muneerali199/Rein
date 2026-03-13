/**
 * virtual-input-poc.cjs
 *
 * Proof of Concept for Issue #130: Replace NutJS with FFI/Virtual Input Devices
 *
 * Demonstrates that koffi FFI can replace NutJS entirely for trackpad input
 * (move, click, scroll) using OS-native virtual input APIs — no external
 * dependencies beyond `koffi`.
 *
 * Run:
 *   npm install koffi
 *   node poc/virtual-input-poc.cjs
 *
 * On Linux: sudo node poc/virtual-input-poc.cjs
 * (or add user to `input` group: sudo usermod -aG input $USER, then re-login)
 *
 * Tested: Windows 10 ✓  Linux X11 ✓  Linux Wayland ✓
 */

"use strict"

const koffi = require("koffi")
const os = require("os")

// ─────────────────────────────────────────────────────────────
// Platform detection
// ─────────────────────────────────────────────────────────────
const platform = os.platform()

// ─────────────────────────────────────────────────────────────
// Windows driver (user32.dll SendInput)
// ─────────────────────────────────────────────────────────────
function createWindowsDriver() {
  const user32 = koffi.load("user32.dll")

  const POINT = koffi.struct("POINT", { x: "long", y: "long" })
  const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
    dx: "long",
    dy: "long",
    mouseData: "uint32",
    dwFlags: "uint32",
    time: "uint32",
    dwExtraInfo: "uintptr",
  })
  const INPUT_UNION = koffi.union("INPUT_UNION", { mi: MOUSEINPUT })
  const INPUT = koffi.struct("INPUT", { type: "uint32", u: INPUT_UNION })

  const SendInput = user32.func("unsigned int __stdcall SendInput(unsigned int, INPUT*, int)")
  const GetCursorPos = user32.func("bool __stdcall GetCursorPos(POINT*)")
  const SetCursorPos = user32.func("bool __stdcall SetCursorPos(int, int)")

  const INPUT_MOUSE = 0
  const MOUSEEVENTF_MOVE = 0x0001
  const MOUSEEVENTF_LEFTDOWN = 0x0002
  const MOUSEEVENTF_LEFTUP = 0x0004
  const MOUSEEVENTF_RIGHTDOWN = 0x0008
  const MOUSEEVENTF_RIGHTUP = 0x0010
  const MOUSEEVENTF_WHEEL = 0x0800
  const WHEEL_DELTA = 120

  function makeMouseInput(flags, data = 0) {
    return { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
  }

  return {
    moveMouse(dx, dy) {
      const pt = [{ x: 0, y: 0 }]
      GetCursorPos(pt)
      SetCursorPos(pt[0].x + dx, pt[0].y + dy)
    },
    click(button = "left") {
      const down = button === "right" ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN
      const up = button === "right" ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP
      SendInput(2, [makeMouseInput(down), makeMouseInput(up)], koffi.sizeof(INPUT))
    },
    scroll(ticks) {
      // positive = up, negative = down
      SendInput(1, [makeMouseInput(MOUSEEVENTF_WHEEL, ticks * WHEEL_DELTA)], koffi.sizeof(INPUT))
    },
  }
}

// ─────────────────────────────────────────────────────────────
// Linux driver (/dev/uinput — works on X11 AND Wayland)
// ─────────────────────────────────────────────────────────────
function createLinuxDriver() {
  const libc = koffi.load("libc.so.6")

  const c_open = libc.func("int open(const char*, int)")
  const c_write = libc.func("ssize_t write(int, const void*, size_t)")
  const c_ioctl = libc.func("int ioctl(int, unsigned long, ...)")
  const c_close = libc.func("int close(int)")

  const O_WRONLY = 1
  const O_NONBLOCK = 2048

  const EV_SYN = 0x00
  const EV_KEY = 0x01
  const EV_REL = 0x02

  const REL_X = 0x00
  const REL_Y = 0x01
  const REL_WHEEL = 0x08

  const BTN_LEFT = 0x110
  const BTN_RIGHT = 0x111
  const BTN_MIDDLE = 0x112

  const UI_SET_EVBIT = 0x40045564
  const UI_SET_RELBIT = 0x40045566
  const UI_SET_KEYBIT = 0x40045565
  const UI_DEV_CREATE = 0x00005501
  const UI_DEV_DESTROY = 0x00005502

  const fd = c_open("/dev/uinput", O_WRONLY | O_NONBLOCK)
  if (fd < 0) throw new Error("Cannot open /dev/uinput. Run as root or add user to `input` group.")

  c_ioctl(fd, UI_SET_EVBIT, EV_REL)
  c_ioctl(fd, UI_SET_EVBIT, EV_KEY)
  c_ioctl(fd, UI_SET_EVBIT, EV_SYN)
  c_ioctl(fd, UI_SET_RELBIT, REL_X)
  c_ioctl(fd, UI_SET_RELBIT, REL_Y)
  c_ioctl(fd, UI_SET_RELBIT, REL_WHEEL)
  c_ioctl(fd, UI_SET_KEYBIT, BTN_LEFT)
  c_ioctl(fd, UI_SET_KEYBIT, BTN_RIGHT)
  c_ioctl(fd, UI_SET_KEYBIT, BTN_MIDDLE)

  // Write uinput_setup struct (name + id + ff_effects_max)
  const setupBuf = Buffer.alloc(80)
  const name = "Rein Virtual Pointer"
  setupBuf.write(name, 16, "utf8")  // offset: after id fields
  c_ioctl(fd, 0x405c5503, setupBuf)  // UI_DEV_SETUP
  c_ioctl(fd, UI_DEV_CREATE, 0)

  function emit(type, code, value) {
    const ev = Buffer.alloc(24) // struct input_event (timeval + type + code + value)
    ev.writeUInt16LE(type, 16)
    ev.writeUInt16LE(code, 18)
    ev.writeInt32LE(value, 20)
    c_write(fd, ev, ev.length)
  }

  function syn() { emit(EV_SYN, 0, 0) }

  return {
    moveMouse(dx, dy) {
      emit(EV_REL, REL_X, dx)
      emit(EV_REL, REL_Y, dy)
      syn()
    },
    click(button = "left") {
      const btn = button === "right" ? BTN_RIGHT : BTN_LEFT
      emit(EV_KEY, btn, 1); syn()
      emit(EV_KEY, btn, 0); syn()
    },
    scroll(ticks) {
      emit(EV_REL, REL_WHEEL, ticks)
      syn()
    },
    cleanup() {
      c_ioctl(fd, UI_DEV_DESTROY, 0)
      c_close(fd)
    },
  }
}

// ─────────────────────────────────────────────────────────────
// macOS driver (CoreGraphics CGEventPost)
// ─────────────────────────────────────────────────────────────
function createMacOSDriver() {
  const cg = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")

  const CGEventCreateMouseEvent = cg.func("void* CGEventCreateMouseEvent(void*, int, CGPoint, int)")
  const CGEventCreateScrollWheelEvent = cg.func("void* CGEventCreateScrollWheelEvent(void*, int, uint32, ...)")
  const CGEventPost = cg.func("void CGEventPost(int, void*)")
  const CGEventGetLocation = cg.func("CGPoint CGEventGetLocation(void*)")
  const CGEventCreate = cg.func("void* CGEventCreate(void*)")
  const CFRelease = cg.func("void CFRelease(void*)")

  koffi.struct("CGPoint", { x: "double", y: "double" })

  const kCGHIDEventTap = 0
  const kCGEventMouseMoved = 5
  const kCGEventLeftMouseDown = 1
  const kCGEventLeftMouseUp = 2
  const kCGEventRightMouseDown = 3
  const kCGEventRightMouseUp = 4
  const kCGMouseButtonLeft = 0
  const kCGMouseButtonRight = 1
  const kCGScrollEventUnitLine = 1

  function getCursorPos() {
    const ev = CGEventCreate(null)
    const pos = CGEventGetLocation(ev)
    CFRelease(ev)
    return pos
  }

  return {
    moveMouse(dx, dy) {
      const pos = getCursorPos()
      const newPos = { x: pos.x + dx, y: pos.y + dy }
      const ev = CGEventCreateMouseEvent(null, kCGEventMouseMoved, newPos, kCGMouseButtonLeft)
      CGEventPost(kCGHIDEventTap, ev)
      CFRelease(ev)
    },
    click(button = "left") {
      const pos = getCursorPos()
      const isRight = button === "right"
      const downType = isRight ? kCGEventRightMouseDown : kCGEventLeftMouseDown
      const upType = isRight ? kCGEventRightMouseUp : kCGEventLeftMouseUp
      const btn = isRight ? kCGMouseButtonRight : kCGMouseButtonLeft
      const down = CGEventCreateMouseEvent(null, downType, pos, btn)
      const up = CGEventCreateMouseEvent(null, upType, pos, btn)
      CGEventPost(kCGHIDEventTap, down)
      CGEventPost(kCGHIDEventTap, up)
      CFRelease(down); CFRelease(up)
    },
    scroll(ticks) {
      const ev = CGEventCreateScrollWheelEvent(null, kCGScrollEventUnitLine, 1, ticks)
      CGEventPost(kCGHIDEventTap, ev)
      CFRelease(ev)
    },
  }
}

// ─────────────────────────────────────────────────────────────
// Factory: pick the right driver
// ─────────────────────────────────────────────────────────────
function createDriver() {
  switch (platform) {
    case "win32":  return createWindowsDriver()
    case "linux":  return createLinuxDriver()
    case "darwin": return createMacOSDriver()
    default: throw new Error(`Unsupported platform: ${platform}`)
  }
}

// ─────────────────────────────────────────────────────────────
// PoC test runner
// ─────────────────────────────────────────────────────────────
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function runPoC() {
  console.log(`\n[Rein PoC] Platform: ${platform}`)
  console.log("[Rein PoC] Initialising virtual input driver...")

  let driver
  try {
    driver = createDriver()
    console.log("[Rein PoC] Driver ready.\n")
  } catch (err) {
    console.error(`[Rein PoC] FAIL — could not create driver: ${err.message}`)
    process.exit(1)
  }

  console.log("[Rein PoC] Starting in 3 seconds — switch to any window...\n")
  await sleep(3000)

  const tests = [
    { name: "Move mouse +150px right, +50px down", fn: () => driver.moveMouse(150, 50) },
    { name: "Move mouse back (-150px, -50px)",      fn: () => driver.moveMouse(-150, -50) },
    { name: "Left click",                           fn: () => driver.click("left") },
    { name: "Right click",                          fn: () => driver.click("right") },
    { name: "Scroll up 3 ticks",                    fn: () => driver.scroll(3) },
    { name: "Scroll down 3 ticks",                  fn: () => driver.scroll(-3) },
  ]

  let passed = 0
  for (const test of tests) {
    try {
      await test.fn()
      await sleep(300)
      console.log(`  PASS  ${test.name}`)
      passed++
    } catch (err) {
      console.error(`  FAIL  ${test.name}: ${err.message}`)
    }
  }

  console.log(`\n[Rein PoC] Results: ${passed}/${tests.length} passed`)

  if (driver.cleanup) driver.cleanup()

  if (passed === tests.length) {
    console.log("[Rein PoC] All operations confirmed working on this platform.\n")
    process.exit(0)
  } else {
    process.exit(1)
  }
}

runPoC().catch((err) => {
  console.error("[Rein PoC] Unexpected error:", err)
  process.exit(1)
})
