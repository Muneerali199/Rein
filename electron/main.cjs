const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

let mainWindow;
let serverProcess;
let serverHost = '0.0.0.0';  // Bind to all interfaces so LAN clients can connect
let serverPort = 3000;

// ── User-data directory (survives reinstall and version upgrades) ─────────────
// Fix for Issue #115: previously config was stored relative to the executable
// and wiped on every reinstall. app.getPath('userData') persists correctly on:
//   Linux:   ~/.config/rein
//   macOS:   ~/Library/Application Support/rein
//   Windows: %APPDATA%\rein
const USER_DATA_DIR = app.getPath('userData');
const CONFIG_FILE   = path.join(USER_DATA_DIR, 'server-settings.json');
const TOKENS_FILE   = path.join(USER_DATA_DIR, 'tokens.json');

// Ensure user data directory exists
try { fs.mkdirSync(USER_DATA_DIR, { recursive: true }); } catch {}

// Expose paths to the server process via environment variables
process.env.REIN_CONFIG_FILE = CONFIG_FILE;
process.env.REIN_TOKENS_FILE = TOKENS_FILE;

try {
  if (fs.existsSync(CONFIG_FILE)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (config.host) serverHost = config.host;
    if (config.frontendPort) serverPort = config.frontendPort;
  }
} catch (e) {
  console.warn('Failed to load server config:', e);
}

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Wait until server is ready
function waitForServer(url) {
  return new Promise((resolve) => {
    const check = () => {
      http
        .get(url, () => resolve())
        .on('error', () => setTimeout(check, 500));
    };
    check();
  });
}

// Start Nitro server (production)
function startServer() {
  return new Promise((resolve) => {
    const serverPath = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      '.output',
      'server',
      'index.mjs'
    );

    console.log("Starting server from:", serverPath);

    serverProcess = spawn('node', [serverPath], {
      stdio: 'ignore',       // no terminal
      windowsHide: true,     // hide CMD
      env: {
        ...process.env,
        HOST: serverHost,
        PORT: serverPort.toString(),
      },
    });

    waitForServer(`http://localhost:${serverPort}`).then(resolve);
  });
}

// Create window
function createWindow() {
  if (mainWindow) return;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Grant display-capture and screen permissions for screen mirroring
  // (Electron does not inherit browser permission grants automatically)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['display-capture', 'screen', 'media'];
    const isLocalhost = webContents.getURL().startsWith(`http://localhost:${serverPort}`);
    callback(isLocalhost && allowedPermissions.includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const allowedPermissions = ['display-capture', 'screen', 'media'];
    const isLocalhost = webContents.getURL().startsWith(`http://localhost:${serverPort}`);
    return isLocalhost && allowedPermissions.includes(permission);
  });

  mainWindow.loadURL(`http://localhost:${serverPort}`);

  // Show when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    console.log("LOAD FAILED:", code, desc);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App start
app.whenReady().then(async () => {
  await startServer();
  createWindow();

  // macOS: re-create window when dock icon is clicked
  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
});

// Cleanup
app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  // On macOS, keep the process alive until user quits explicitly (Cmd+Q)
  if (process.platform !== 'darwin') app.quit();
});