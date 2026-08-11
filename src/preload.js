const { contextBridge, ipcRenderer } = require('electron');
const os = require('os');

/**
 * Puente seguro entre el renderer (xterm.js) y el main (node-pty + ventana).
 * El renderer nunca toca Node directo.
 *
 * Todo lo de shells lleva `id`: hay una pty por tab, y el input tiene que ir sólo
 * a la del tab activo.
 */
contextBridge.exposeInMainWorld('terminal', {
  spawn: (opts) => ipcRenderer.invoke('terminal:spawn', opts),
  write: (id, data) => ipcRenderer.send('terminal:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('terminal:kill', { id }),
  onData: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onExit: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  }
});

// Controles de la ventana frameless + aviso de foco del SO.
contextBridge.exposeInMainWorld('app', {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  onFocus: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('window:focus', listener);
    return () => ipcRenderer.removeListener('window:focus', listener);
  },
  onMaximizeState: (cb) => {
    const listener = (_e, maximized) => cb(maximized);
    ipcRenderer.on('window:maximize-state', listener);
    return () => ipcRenderer.removeListener('window:maximize-state', listener);
  },
  // La versión que muestra la status bar. Sale de app.getVersion() y no de un require
  // del package.json: empaquetada es la misma, pero getVersion es la fuente de verdad
  // que también usa el updater para decidir si un release es más nuevo.
  getVersion: () => ipcRenderer.invoke('app:version')
});

/**
 * Auto-update. check(manual): manual=true → el usuario lo pidió, así que el toast
 * muestra también los desenlaces aburridos ("estás al día", errores). Con manual=false
 * el chequeo es silencioso y sólo habla si hay una versión nueva.
 * onStatus recibe { phase, manual, version?, percent?, error? }.
 */
contextBridge.exposeInMainWorld('updater', {
  check: (manual) => ipcRenderer.invoke('update:check', { manual: !!manual }),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  onStatus: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  }
});

// Home del usuario, para acortar rutas en la status bar.
contextBridge.exposeInMainWorld('terminalHome', os.homedir());
