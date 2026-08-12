const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, screen } = require('electron');

// Mata el flash blanco intermitente al minimizar→restaurar (Win11). Cuando la ventana se
// minimiza Windows la marca como ocluida; Chromium la manda a background y libera su
// superficie de composición GPU. Al restaurar, el swap chain repinta en blanco por un
// frame. Estos switches evitan ese backgrounding, así el último frame ya está ahí al
// volver. Tienen que correr ANTES de app.whenReady().
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// ---------------------------------------------------------------------------
// Instancia única
// ---------------------------------------------------------------------------
// Sin el lock, cada doble click en el acceso directo levanta otra app entera: dos
// trays, dos juegos de shells, dos ventanas. Con el atajo global es peor, porque
// Ctrl+Alt+T lo da Windows en exclusiva: se lo queda la primera instancia y la
// segunda falla al registrarlo. Si después se cierra la primera, su unregisterAll()
// libera el atajo y la que sigue viva nunca lo tuvo — el atajo queda muerto sin que
// se haya cerrado nada. Tiene que correr antes de whenReady().
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
}

// El segundo lanzamiento se mata solo, pero antes nos avisa: es el usuario haciendo
// doble click para ver la app, así que la traemos al frente en vez de togglear (que
// la escondería justo cuando la está pidiendo).
app.on('second-instance', () => { revealWindow(); });

const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
let tray = null;
let isQuitting = false;

/** ptys vivos, por id. Cada tab del renderer tiene el suyo. */
const shells = new Map();
let ptyIdCounter = 0;

/** Trae la ventana al frente esté oculta en el tray, minimizada o solo sin foco. */
function revealWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();

  // Windows no deja que un proceso en background se robe el foreground, y cuando el
  // disparo viene del atajo global el foreground es justamente OTRA app. show()+focus()
  // a secas deja la ventana atrás o parpadeando en la barra de tareas; y como
  // isFocused() se queda en false, el toggle nunca llega a la rama de esconder y cada
  // Ctrl+Alt+T vuelve a "mostrar" una ventana que ya estaba ahí. Pasar por alwaysOnTop
  // fuerza el z-order y la sube de verdad; lo bajamos en el acto para no dejarla
  // clavada arriba de todo.
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
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
    console.error('[NTERMX] no pude preparar el init de shell:', err.message);
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

const WIN_W = 1113;
const WIN_H = 626;

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');

  // Centrado a mano sobre el área útil del primario (descuenta la taskbar): abajo
  // pasamos x/y explícitos para nacer off-screen, y eso desactiva el auto-centrado.
  const { x: waX, y: waY, width: waW, height: waH } = screen.getPrimaryDisplay().workArea;
  const winX = Math.max(waX, Math.round(waX + (waW - WIN_W) / 2));
  const winY = Math.max(waY, Math.round(waY + (waH - WIN_H) / 2));

  mainWindow = new BrowserWindow({
    // El fondo gris del arranque es el frame que pinta el compositor de Windows cuando
    // mapea el HWND en el primer show(), por encima del swap chain de Chromium: no lo
    // tapa backgroundColor ni nada del contenido. No se puede evitar, pero sí correrlo
    // a donde nadie lo vea. Nacemos a -20000px, mostramos ahí, y recién después la
    // movemos al centro — aparece ya pintada con lo nuestro.
    x: -20000,
    y: -20000,
    width: WIN_W,
    height: WIN_H,
    minWidth: 520,
    minHeight: 360,
    title: 'ntermx',
    show: false,
    paintWhenInitiallyHidden: true, // que pinte el primer frame aunque esté oculta
    backgroundColor: '#050507', // = --st-bg-deep, lo que se ve hasta que carga el CSS
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

  // ready-to-show = el renderer ya pintó su primer frame. El show() de acá es el que se
  // come el gris del compositor, off-screen. Los 200 ms le dan tiempo al compositor a
  // asentar la superficie antes de mover: moverla antes dispara un segundo gris, esta
  // vez en el centro de la pantalla. Menos de 200 sale intermitente.
  mainWindow.once('ready-to-show', () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    win.show();
    setTimeout(() => {
      if (!win.isDestroyed()) win.setPosition(winX, winY);
    }, 200);
  });

  // El 'focus' del BrowserWindow capta todos los alt-tab / click en taskbar / restore
  // desde el tray, que el focus del DOM a veces se pierde en Windows (frameless + DWM).
  // El renderer lo usa para devolverle el foco al xterm del tab activo.
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:focus');
    }
  });

  // Estado de maximizado: el renderer lo usa para swapear el ícono del botón
  // maximizar/restaurar. Mandamos el estado inicial y luego cada cambio.
  const sendMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximize-state', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);
  // El primer estado llega cuando el renderer termine de cargar; lo mandamos ahí.
  mainWindow.webContents.once('did-finish-load', sendMaxState);

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
  const iconPath = path.join(__dirname, 'ntermx-tray.ico');
  if (!fs.existsSync(iconPath)) {
    console.error('[NTERMX] falta el ícono del tray:', iconPath);
    return;
  }
  tray = new Tray(nativeImage.createFromPath(iconPath));

  tray.setToolTip('ntermx');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show ntermx', click: revealWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
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
const HOTKEY = 'CommandOrControl+Alt+T';

function registerHotkeys() {
  // register() ya devuelve false si la combinación está tomada, pero lo confirmamos
  // contra isRegistered(): lo único que importa es que quede efectivamente enganchada.
  const ok = globalShortcut.register(HOTKEY, toggleWindow) && globalShortcut.isRegistered(HOTKEY);
  if (!ok) {
    // En la app empaquetada nadie ve la consola, así que el fallo se cuenta también
    // en el tray: si no, el atajo simplemente "no anda" y no hay forma de saber por qué.
    console.error('[NTERMX] no pude registrar Ctrl+Alt+T: lo tiene tomado otra app.');
    if (tray) tray.setToolTip('ntermx — Ctrl+Alt+T unavailable (taken by another app)');
  }
  return ok;
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

// Maximize toggle: si está maximizada restaura, si no maximiza. Hacerlo con
// isMaximized() en vez de mandar maximize() ciegamente permite que el botón
// funcione igual en ventanas secundarias o cuando el estado del renderer se
// desincronice (p.ej. al arrastrar la ventana al borde superior en Win11, que
// maximiza sin pasar por acá).
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.on('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

// ---------------------------------------------------------------------------
// Auto-update (electron-updater)
// ---------------------------------------------------------------------------
// Sólo funciona en la app EMPAQUETADA: se apoya en el app-update.yml que genera
// electron-builder y en el latest.yml del release de GitHub. En dev (npm start) no
// existe ninguno de los dos, así que el check dispara una SIMULACIÓN del flujo entero
// que emite los mismos 'update:status' que el camino real — sirve para ver y ajustar el
// toast sin tener que publicar un release para probarlo.
let _autoUpdater;            // instancia cacheada (lazy require; puede quedar null)
let _updaterWired = false;   // listeners registrados una sola vez
let updateManual = false;    // el check en curso lo pidió el usuario → feedback visible

/** Envío defensivo al renderer: la ventana puede estar escondida en el tray o destruida. */
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function sendUpdate(phase, extra) {
  sendToRenderer('update:status', { phase, manual: updateManual, ...(extra || {}) });
}

function getAutoUpdater() {
  if (_autoUpdater !== undefined) return _autoUpdater;
  try {
    _autoUpdater = require('electron-updater').autoUpdater;
    _autoUpdater.autoDownload = false;        // primero avisamos; el usuario decide
    _autoUpdater.autoInstallOnAppQuit = true;
    _autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
  } catch (err) {
    console.error('[NTERMX] electron-updater no disponible:', err.message);
    _autoUpdater = null;
  }
  return _autoUpdater;
}

function wireAutoUpdater(up) {
  if (_updaterWired || !up) return;
  _updaterWired = true;
  up.on('checking-for-update', () => sendUpdate('checking'));
  up.on('update-available',     (info) => sendUpdate('available', { version: info && info.version }));
  up.on('update-not-available', () => sendUpdate('none'));
  up.on('download-progress',    (p) => sendUpdate('downloading', { percent: Math.round((p && p.percent) || 0) }));
  up.on('update-downloaded',    (info) => sendUpdate('downloaded', { version: info && info.version }));
  up.on('error',                (err) => sendUpdate('error', { error: (err && err.message) || String(err) }));
}

// Simulación de dev: los mismos update:status que el camino real, movidos por timers.
let simTimers = [];
const SIM_VERSION = '9.9.9';
function clearSim() { simTimers.forEach(clearTimeout); simTimers = []; }
function simCheck() {
  clearSim();
  sendUpdate('checking');
  simTimers.push(setTimeout(() => sendUpdate('available', { version: SIM_VERSION }), 950));
}
function simDownload() {
  clearSim();
  let pct = 0;
  const tick = () => {
    pct += 4 + Math.floor(Math.random() * 15);
    if (pct >= 100) {
      sendUpdate('downloading', { percent: 100 });
      simTimers.push(setTimeout(() => sendUpdate('downloaded', { version: SIM_VERSION }), 450));
      return;
    }
    sendUpdate('downloading', { percent: pct });
    simTimers.push(setTimeout(tick, 240));
  };
  simTimers.push(setTimeout(tick, 200));
}

ipcMain.handle('update:check', (_e, opts) => {
  updateManual = !!(opts && opts.manual);
  if (!app.isPackaged) { simCheck(); return { simulated: true }; }
  const up = getAutoUpdater();
  if (!up) { sendUpdate('error', { error: 'Updater unavailable.' }); return { ok: false }; }
  wireAutoUpdater(up);
  Promise.resolve(up.checkForUpdates()).catch((err) => sendUpdate('error', { error: err.message }));
  return { ok: true };
});

ipcMain.handle('update:download', () => {
  if (!app.isPackaged) { simDownload(); return { simulated: true }; }
  const up = getAutoUpdater();
  if (!up) return { ok: false };
  Promise.resolve(up.downloadUpdate()).catch((err) => sendUpdate('error', { error: err.message }));
  return { ok: true };
});

ipcMain.handle('update:install', () => {
  if (!app.isPackaged) { console.log('[NTERMX] (dev sim) quitAndInstall'); sendUpdate('sim-install'); return { simulated: true }; }
  const up = getAutoUpdater();
  if (!up) return { ok: false };
  // CRÍTICO: sin isQuitting = true el handler de 'close' esconde la ventana en el tray
  // en vez de dejarla cerrar, y la instalación no corre nunca. Lo forzamos y salimos en
  // el próximo tick.
  isQuitting = true;
  setImmediate(() => {
    try { up.quitAndInstall(); } catch (e) { console.error('[NTERMX] quitAndInstall falló:', e.message); }
  });
  return { ok: true };
});

ipcMain.handle('app:version', () => app.getVersion());

// --- Cache del updater ---
// electron-updater deja el instalador montado en <cache>/pending para correrlo al salir
// (autoInstallOnAppQuit). Una vez que la instalación se aplicó eso es peso muerto: ~100 MB
// y un install pendiente que puede volver a dispararse. Lo borramos sólo si la versión
// montada es <= la que estamos corriendo; si es MÁS nueva es un update legítimo esperando
// el próximo quit, y ese no se toca.
function updaterCacheDirName() {
  // Fuente de verdad: el app-update.yml que genera electron-builder. Leerlo en vez de
  // hardcodear el nombre evita que esto deje de limpiar en silencio si algún día cambia.
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const m = yml.match(/^updaterCacheDirName:\s*(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* en dev no existe */ }
  return null;
}

function compareVersion(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function cleanStaleUpdaterCache() {
  if (!app.isPackaged || !process.env.LOCALAPPDATA) return;
  const dirName = updaterCacheDirName();
  if (!dirName) return;
  const pending = path.join(process.env.LOCALAPPDATA, dirName, 'pending');

  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(pending, 'update-info.json'), 'utf8')); }
  catch { return; }   // no hay nada montado: el caso normal

  // artifactName es ${productName}-Setup-${version}.${ext} (package.json > build.nsis).
  const m = String(info.fileName || '').match(/-Setup-(\d+\.\d+\.\d+)\.exe$/i);
  if (!m) return;                                          // nombre inesperado: no tocamos
  if (compareVersion(m[1], app.getVersion()) > 0) return;   // update legítimo pendiente

  try {
    await fs.promises.rm(pending, { recursive: true, force: true });
    console.log(`[NTERMX] cache del updater limpiada (v${m[1]} ya está instalada)`);
  } catch (err) {
    console.error('[NTERMX] no pude limpiar la cache del updater:', err.message);
  }
}

// ---- Ciclo de vida ----

app.whenReady().then(() => {
  // La instancia que pierde el lock ya salió por app.exit(0) allá arriba. Este corte es
  // el cinturón sobre los tiradores: si por lo que sea llegara igual hasta acá, no
  // queremos que fabrique ventana, tray, hotkeys ni shells de más justo antes de morir.
  if (!gotTheLock) return;

  createWindow();
  createTray();
  registerHotkeys();
  // Sin await: no es urgente y puede tardar borrando ~100 MB.
  cleanStaleUpdaterCache();

  // Chequeo automático al arrancar, sólo empaquetada. Va en silencio (updateManual =
  // false): el toast no aparece salvo que haya de verdad una versión nueva. Los 4s son
  // para no pelear con el arranque de las shells.
  if (app.isPackaged) {
    setTimeout(() => {
      updateManual = false;
      const up = getAutoUpdater();
      if (!up) return;
      wireAutoUpdater(up);
      Promise.resolve(up.checkForUpdates())
        .catch((err) => console.error('[NTERMX] el auto-check de updates falló:', err.message));
    }, 4000);
  }

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
