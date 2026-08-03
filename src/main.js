const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut } = require('electron');

// Mata el flash blanco intermitente al minimizar→restaurar (Win11). Cuando la ventana se
// minimiza Windows la marca como ocluida; Chromium la manda a background y libera su
// superficie de composición GPU. Al restaurar, el swap chain repinta en blanco por un
// frame. Estos switches evitan ese backgrounding, así el último frame ya está ahí al
// volver. Tienen que correr ANTES de app.whenReady().
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const { execFileSync } = require('child_process');

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
let tray = null;
let isQuitting = false;

/** ptys vivos, por id. Cada tab del renderer tiene el suyo. */
const shells = new Map();
let ptyIdCounter = 0;

// ---------------------------------------------------------------------------
// Instancia única: si ya hay una corriendo, la segunda se cierra y hace aparecer
// la primera (que puede estar escondida en el tray).
// ---------------------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    revealWindow();
  });
}

/** Trae la ventana al frente esté oculta en el tray, minimizada o solo sin foco. */
function revealWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/**
 * Resuelve el ejecutable de PowerShell. Preferimos PowerShell 7 (pwsh.exe) si está
 * instalado; si no, el Windows PowerShell 5.1 de fábrica.
 */
function resolvePowerShell() {
  if (process.platform === 'win32') {
    const ps7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    if (fs.existsSync(ps7)) return { shell: ps7, isPs7: true };
    return { shell: 'powershell.exe', isPs7: false };
  }
  return { shell: 'pwsh', isPs7: true };
}

/**
 * Path al init de shell, listo para que pwsh lo dot-sourcee.
 *
 * Empaquetado, prompt.ps1 vive DENTRO de app.asar, y pwsh no sabe leer de ahí (el asar
 * es un pseudo-FS que sólo entiende Node). Así que lo leemos con fs —que sí es
 * asar-aware— y lo escribimos al userData, que es filesystem de verdad. Se cachea: una
 * sola copia por corrida, no una por shell.
 */
let initScriptPath;
function resolveInitScript() {
  if (initScriptPath !== undefined) return initScriptPath;
  try {
    const src = path.join(__dirname, 'prompt.ps1');
    const content = fs.readFileSync(src, 'utf8');
    const dest = path.join(app.getPath('userData'), 'prompt.ps1');
    fs.writeFileSync(dest, content, 'utf8');
    initScriptPath = dest;
  } catch (err) {
    console.error('[ARGON] no pude preparar el init de shell:', err.message);
    initScriptPath = null;
  }
  return initScriptPath;
}

const psQuote = (p) => p.replace(/'/g, "''"); // comilla simple en PS = duplicarla

function spawnShell(cols = 80, rows = 24) {
  const { shell, isPs7 } = resolvePowerShell();

  // Sesión interactiva real. NO pasamos -NoProfile a propósito: queremos que pwsh
  // cargue el perfil del usuario (core-profile de UMBROCORE-X) con todas sus
  // funciones. Recién después dot-sourceamos nuestro init, que envuelve el prompt
  // que haya quedado para agregarle OSC 7.
  const args = ['-NoLogo', '-NoExit'];
  const init = resolveInitScript();
  if (init) args.push('-Command', `. '${psQuote(init)}'`);

  const ptyProc = pty.spawn(shell, args, {
    name: 'xterm-color',
    cols,
    rows,
    cwd: os.homedir(),
    env: process.env
  });

  const id = ++ptyIdCounter;
  shells.set(id, ptyProc);

  ptyProc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', { id, data });
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    shells.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', { id, exitCode });
    }
  });

  return { id, isPs7 };
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1113,
    height: 626,
    minWidth: 520,
    minHeight: 360,
    title: 'Argon',
    backgroundColor: '#050507', // con Electron 40 esto tiñe el frame fantasma del compositor
    titleBarStyle: 'hidden',
    frame: false,
    autoHideMenuBar: true,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // El 'focus' del BrowserWindow capta todos los alt-tab / click en taskbar / restore
  // desde el tray, que el focus del DOM a veces se pierde en Windows (frameless + DWM).
  // El renderer lo usa para devolverle el foco al xterm del tab activo.
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:focus');
    }
  });

  // Cerrar esconde al tray en vez de matar la app: las shells siguen vivas.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  const iconPath = path.join(__dirname, 'argon-tray.ico');
  if (!fs.existsSync(iconPath)) {
    console.error('[ARGON] falta el ícono del tray:', iconPath);
    return;
  }
  tray = new Tray(nativeImage.createFromPath(iconPath));

  tray.setToolTip('Argon');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostrar Argon', click: revealWindow },
    { type: 'separator' },
    { label: 'Salir', click: () => { isQuitting = true; app.quit(); } }
  ]));

  tray.on('click', toggleWindow);
}

/** Muestra si está oculta/sin foco; esconde si ya está visible y enfocada. */
function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    revealWindow();
  }
}

// ---------------------------------------------------------------------------
// Atajo global: Ctrl+Alt+T
// ---------------------------------------------------------------------------
function registerHotkeys() {
  const ok = globalShortcut.register('CommandOrControl+Alt+T', toggleWindow);
  if (!ok) {
    console.error('[ARGON] no pude registrar Ctrl+Alt+T (¿lo tiene tomado otra app?)');
  }
}

// ---- IPC: shells ----

ipcMain.handle('terminal:spawn', (_e, { cols, rows } = {}) => spawnShell(cols, rows));

ipcMain.on('terminal:input', (_e, { id, data }) => {
  const proc = shells.get(id);
  if (proc) proc.write(data);
});

ipcMain.on('terminal:resize', (_e, { id, cols, rows }) => {
  const proc = shells.get(id);
  if (!proc) return;
  try { proc.resize(cols, rows); } catch { /* el proceso ya murió */ }
});

ipcMain.on('terminal:kill', (_e, { id }) => {
  const proc = shells.get(id);
  if (!proc) return;
  try { proc.kill(); } catch { /* ya estaba muerto */ }
  shells.delete(id);
});

// ---- IPC: controles de ventana (frameless) ----
ipcMain.on('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.on('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

// ---------------------------------------------------------------------------
// Restos de una instancia anterior
// ---------------------------------------------------------------------------
// Una salida sucia —un cierre que no termina de irse, un crash a mitad del quit— deja un
// proceso huérfano. Su ventana ya no renderiza, pero Windows la sigue componiendo, lavada,
// por debajo de la nueva: abrir la app se ve como un pestañeo gris. No es un problema de
// pintado, el layout ya está entero; lo único que se mueve es el alfa.
//
// Registramos el PID de cada main que arranca y el siguiente mata al anterior si sigue
// vivo. El registro NO se borra al salir, a propósito: si el proceso se fue de verdad la
// consulta falla sola y no cuesta un spawn; si quedó colgado, es justo lo que buscamos.
//
// Corre sólo después de ganar el lock de instancia única, así que cualquier otro proceso
// nuestro que siga vivo es por definición un resto. Si el colgado fuera el que RETIENE el
// lock, esta instancia ni arranca: ese caso queda afuera a propósito, porque matar a quien
// tiene el lock es exactamente lo que el lock existe para evitar.

const instanceRecordPath = () => path.join(app.getPath('userData'), 'instance.json');

/** Mata el main de la corrida anterior si quedó colgado. */
function killLeftoverInstance() {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(instanceRecordPath(), 'utf8')); } catch { return; }
  if (!rec || !Number.isInteger(rec.pid) || rec.pid === process.pid) return;

  // ¿sigue vivo? kill(pid, 0) no manda ninguna señal, sólo consulta. ESRCH = ya no existe
  // (el camino normal, y sale gratis). EPERM significa que existe pero no lo podemos
  // señalizar, así que seguimos: taskkill /F puede llegar igual.
  try { process.kill(rec.pid, 0); }
  catch (err) { if (err.code !== 'EPERM') return; }

  // Vivo. Puede ser el colgado… o un PID reciclado por un proceso ajeno, así que antes de
  // matar nada confirmamos que la ruta del ejecutable es la nuestra.
  let exe;
  try {
    exe = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${rec.pid}").ExecutablePath`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
  } catch (err) {
    console.error(`[ARGON] no pude verificar el PID ${rec.pid}:`, err.message);
    return;
  }
  const samePath = (a, b) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
  if (!exe || !samePath(exe, process.execPath)) return;   // no es nuestro: no se toca

  // /T se lleva también los helpers (renderer, GPU, utility): no mueren solos si el main
  // quedó colgado, y son los que retienen la superficie que Windows sigue componiendo.
  try {
    execFileSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'],
      { timeout: 5000, windowsHide: true, stdio: 'ignore' });
    console.log(`[ARGON] resto de una instancia anterior (PID ${rec.pid}) eliminado`);
  } catch (err) {
    console.error(`[ARGON] no pude eliminar el PID ${rec.pid}:`, err.message);
  }
}

/** Deja registrado nuestro PID para que la próxima corrida sepa a quién mirar. */
function recordInstance() {
  try {
    fs.writeFileSync(instanceRecordPath(),
      JSON.stringify({ pid: process.pid, version: app.getVersion() }), 'utf8');
  } catch (err) {
    console.error('[ARGON] no pude registrar el PID de la instancia:', err.message);
  }
}

// ---- Ciclo de vida ----

app.whenReady().then(() => {
  // La instancia que pierde el lock ya llamó a app.quit() allá arriba, pero quit() es
  // asíncrono y whenReady llega igual: verificado, la segunda instancia alcanzaba a crear
  // ventana, tray y hotkeys antes de irse. Eso es el pestañeo al abrir la app estando ya
  // corriendo — dos ventanas por un instante, uno que se muere enseguida. Y sin este corte
  // killLeftoverInstance mataría el PID registrado, que es el de la instancia legítima.
  if (!gotTheLock) return;

  // Si quedó una huérfana de la corrida anterior, que se vaya antes de crear la ventana,
  // para que no lleguen a convivir en pantalla.
  killLeftoverInstance();
  recordInstance();

  createWindow();
  createTray();
  registerHotkeys();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// No cerramos la app: la ventana se esconde en el tray y las shells siguen corriendo.
app.on('window-all-closed', () => { /* noop */ });

app.on('before-quit', () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  for (const proc of shells.values()) {
    try { proc.kill(); } catch { /* noop */ }
  }
  shells.clear();
});
