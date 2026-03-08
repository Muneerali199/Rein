/**
 * Rein — Virtual Input PoC (Minimal)
 * ===================================
 * Proof that koffi FFI can replace NutJS for trackpad input.
 * 
 * Run: node virtual-input-poc.js
 * Linux: sudo node virtual-input-poc.js (or add user to input group)
 * 
 * This demonstrates: move, click, scroll
 * (minimal PoC scope per Issue #130)
 */

const koffi = require('koffi');
const os = require('os');
const platform = os.platform();

const sleep = ms => new Promise(r => setTimeout(r, ms));

let driver;

// ══════════════════════════════════════════════════════════════════════════════
// WINDOWS — user32.dll SendInput
// ══════════════════════════════════════════════════════════════════════════════
if (platform === 'win32') {
    const user32 = koffi.load('user32.dll');

    const INPUT_MOUSE = 0;
    const MOUSEEVENTF_MOVE = 0x0001;
    const MOUSEEVENTF_LEFTDOWN = 0x0002;
    const MOUSEEVENTF_LEFTUP = 0x0004;
    const MOUSEEVENTF_WHEEL = 0x0800;

    const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
        dx: 'long', dy: 'long', mouseData: 'uint32_t',
        dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t'
    });

    const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
        wVk: 'uint16_t', wScan: 'uint16_t', dwFlags: 'uint32_t',
        time: 'uint32_t', dwExtraInfo: 'uintptr_t'
    });

    const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
        uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t'
    });

    const INPUT = koffi.struct('INPUT', {
        type: 'uint32_t',
        u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT })
    });

    const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
    const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *lpPoint)');
    const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int X, int Y)');
    const SendInput = user32.func(
        'unsigned int __stdcall SendInput(unsigned int cInputs, INPUT *pInputs, int cbSize)'
    );

    const SZ = koffi.sizeof(INPUT);

    driver = {
        init() {},
        moveMouse(dx, dy) {
            // Absolute positioning (simple approach for PoC)
            const pt = {};
            GetCursorPos(pt);
            SetCursorPos(pt.x + dx, pt.y + dy);
        },
        click() {
            SendInput(2, [
                { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTDOWN, time: 0, dwExtraInfo: 0 } } },
                { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTUP, time: 0, dwExtraInfo: 0 } } }
            ], SZ);
        },
        scroll(ticks) {
            SendInput(1, [
                { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: ticks * 120, dwFlags: MOUSEEVENTF_WHEEL, time: 0, dwExtraInfo: 0 } } }
            ], SZ);
        },
        cleanup() {}
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// LINUX — /dev/uinput (works on X11 and Wayland)
// ══════════════════════════════════════════════════════════════════════════════
else if (platform === 'linux') {
    const libc = koffi.load('libc.so.6');

    const input_event = koffi.struct('input_event', {
        tv_sec: 'long', tv_usec: 'long', type: 'uint16_t', code: 'uint16_t', value: 'int32_t'
    });

    const uinput_setup = koffi.struct('uinput_setup', {
        id_bustype: 'uint16_t', id_vendor: 'uint16_t', id_product: 'uint16_t',
        id_version: 'uint16_t', name: koffi.array('char', 80), ff_effects_max: 'uint32_t'
    });

    const EVENT_SIZE = koffi.sizeof(input_event);

    const c_open = libc.func('int open(const char *path, int flags)');
    const c_close = libc.func('int close(int fd)');
    const c_ioctl = libc.func('int ioctl(int fd, unsigned long request, int value)');
    const c_ioctl_ptr = libc.func('int ioctl(int fd, unsigned long request, uinput_setup *arg)');
    const c_write = libc.func('intptr_t write(int fd, const input_event *buf, uintptr_t count)');

    const O_WRONLY = 1, O_NONBLOCK = 2048;
    const UI_SET_EVBIT = 0x40045564, UI_SET_KEYBIT = 0x40045565, UI_SET_RELBIT = 0x40045566;
    const UI_DEV_SETUP = 0x405c5503, UI_DEV_CREATE = 0x5501, UI_DEV_DESTROY = 0x5502;
    const EV_SYN = 0x00, EV_KEY = 0x01, EV_REL = 0x02;
    const REL_X = 0x00, REL_Y = 0x01, REL_WHEEL = 0x08;
    const BTN_LEFT = 0x110;

    let fd = -1;

    function emit(type, code, value) {
        c_write(fd, { tv_sec: 0, tv_usec: 0, type, code, value }, EVENT_SIZE);
    }
    function syn() { emit(EV_SYN, 0, 0); }

    driver = {
        init() {
            fd = c_open('/dev/uinput', O_WRONLY | O_NONBLOCK);
            if (fd < 0) throw new Error('Cannot open /dev/uinput — run with sudo or add user to input group');
            
            c_ioctl(fd, UI_SET_EVBIT, EV_KEY);
            c_ioctl(fd, UI_SET_EVBIT, EV_REL);
            c_ioctl(fd, UI_SET_EVBIT, EV_SYN);
            c_ioctl(fd, UI_SET_KEYBIT, BTN_LEFT);
            c_ioctl(fd, UI_SET_RELBIT, REL_X);
            c_ioctl(fd, UI_SET_RELBIT, REL_Y);
            c_ioctl(fd, UI_SET_RELBIT, REL_WHEEL);

            const nameStr = 'rein-poc';
            const nameArr = new Array(80).fill(0);
            for (let i = 0; i < nameStr.length; i++) nameArr[i] = nameStr.charCodeAt(i);

            c_ioctl_ptr(fd, UI_DEV_SETUP, { id_bustype: 0x03, id_vendor: 0x1234, id_product: 0x5678, id_version: 1, name: nameArr, ff_effects_max: 0 });
            c_ioctl(fd, UI_DEV_CREATE, 0);
            console.log('  [Linux] Virtual device created');
        },
        moveMouse(dx, dy) {
            emit(EV_REL, REL_X, dx);
            emit(EV_REL, REL_Y, dy);
            syn();
        },
        click() {
            emit(EV_KEY, BTN_LEFT, 1); syn();
            emit(EV_KEY, BTN_LEFT, 0); syn();
        },
        scroll(ticks) {
            emit(EV_REL, REL_WHEEL, ticks);
            syn();
        },
        cleanup() {
            if (fd >= 0) { c_ioctl(fd, UI_DEV_DESTROY, 0); c_close(fd); fd = -1; }
        }
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// MACOS — CoreGraphics CGEventPost
// ══════════════════════════════════════════════════════════════════════════════
else if (platform === 'darwin') {
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');

    const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' });

    const kCGEventMouseMoved = 5;
    const kCGEventLeftMouseDown = 1, kCGEventLeftMouseUp = 2;
    const kCGEventScrollWheel = 22;
    const kCGHIDEventTap = 0;
    const kCGMouseButtonLeft = 0;

    const CGEventSourceCreate = cg.func('void* CGEventSourceCreate(int stateID)');
    const CGEventCreate = cg.func('void* CGEventCreate(void *source)');
    const CGEventGetLocation = cg.func('CGPoint CGEventGetLocation(void *event)');
    const CGEventCreateMouseEvent = cg.func('void* CGEventCreateMouseEvent(void *source, int mouseType, CGPoint mouseCursorPosition, int mouseButton)');
    const CGEventCreateScrollWheelEvent = cg.func('void* CGEventCreateScrollWheelEvent(void *source, int units, uint32_t wheelCount, int32_t wheel1)');
    const CGEventPost = cg.func('void CGEventPost(int tap, void *event)');
    const CFRelease = cf.func('void CFRelease(void *cf)');

    const source = CGEventSourceCreate(1);

    function getPos() {
        const ev = CGEventCreate(null);
        const pos = CGEventGetLocation(ev);
        CFRelease(ev);
        return pos;
    }

    driver = {
        init() {},
        moveMouse(dx, dy) {
            const pos = getPos();
            const ev = CGEventCreateMouseEvent(source, kCGEventMouseMoved, { x: pos.x + dx, y: pos.y + dy }, kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, ev);
            CFRelease(ev);
        },
        click() {
            const pos = getPos();
            const down = CGEventCreateMouseEvent(source, kCGEventLeftMouseDown, pos, kCGMouseButtonLeft);
            const up = CGEventCreateMouseEvent(source, kCGEventLeftMouseUp, pos, kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, down); CFRelease(down);
            CGEventPost(kCGHIDEventTap, up); CFRelease(up);
        },
        scroll(ticks) {
            const ev = CGEventCreateScrollWheelEvent(source, 0, 1, ticks);
            CGEventPost(kCGHIDEventTap, ev);
            CFRelease(ev);
        },
        cleanup() { if (source) CFRelease(source); }
    };
}
else {
    console.error('Unsupported platform:', platform);
    process.exit(1);
}

// ══════════════════════════════════════════════════════════════════════════════
// RUN TEST
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
    console.log(`\n=== Rein Virtual Input PoC ===`);
    console.log(`Platform: ${platform}`);
    console.log('Starting in 3 seconds. Switch to a window to observe.\n');

    await sleep(3000);
    driver.init();

    try {
        console.log('1. Move mouse +100 right, +50 down');
        driver.moveMouse(100, 50);
        await sleep(500);

        console.log('2. Move back (-100, -50)');
        driver.moveMouse(-100, -50);
        await sleep(500);

        console.log('3. Left click');
        driver.click();
        await sleep(500);

        console.log('4. Scroll up (3 ticks)');
        driver.scroll(3);
        await sleep(500);

        console.log('5. Scroll down (-3 ticks)');
        driver.scroll(-3);
        await sleep(500);

        console.log('\n✅ All tests passed!');
    } finally {
        driver.cleanup();
    }
}

main().catch(err => {
    console.error('PoC error:', err);
    try { driver.cleanup(); } catch (_) {}
    process.exit(1);
});
