# Virtual Input PoC — Issue #130

A minimal proof-of-concept demonstrating that **koffi FFI can replace NutJS** for trackpad input (move, click, scroll) on Windows, Linux, and macOS.

---

## Quick Test

```bash
npm install koffi
node virtual-input-poc.cjs
```

**On Linux**: `sudo node virtual-input-poc.js` (or add user to `input` group)

The script pauses 3 seconds, then:
1. Moves mouse +100 right / +50 down
2. Moves back to origin
3. Performs a left click
4. Scrolls up 3 ticks
5. Scrolls down 3 ticks

---

## Why This Approach?

| NutJS (current) | koffi FFI (this PoC) |
|------------------|----------------------|
| Application layer (X11/AT-SPI) | Kernel layer (uinput/SendInput/CGEvent) |
| No Wayland support | Works on Wayland |
| Bypasses OS acceleration | OS applies its own acceleration |
| Large native dependency | Lightweight FFI |

---

## Technical Summary

- **Windows**: `user32.dll` → `SendInput` with `MOUSEEVENTF_MOVE`, `MOUSEEVENTF_LEFTDOWN/UP`, `MOUSEEVENTF_WHEEL`
- **Linux**: `/dev/uinput` → write `EV_REL` (REL_X, REL_Y, REL_WHEEL) and `EV_KEY` (BTN_LEFT)
- **macOS**: `CoreGraphics` → `CGEventPost` with `kCGEventMouseMoved`, `kCGEventLeftMouseDown/Up`, `kCGEventScrollWheel`

---

## Tested

- ✅ Windows 10 — all 5 operations confirmed working
- ⏳ Linux — requires `/dev/uinput` access
- ⏳ macOS — requires Accessibility permissions

---

## Scope

This PoC covers only trackpad input (move, click, scroll) as specified in Issue #130. Keyboard support, zoom gestures, and sensitivity handling are **out of scope** for the PoC.
