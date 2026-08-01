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
  close: () => ipcRenderer.send('window:close'),
  onFocus: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('window:focus', listener);
    return () => ipcRenderer.removeListener('window:focus', listener);
  }
});

// Home del usuario, para acortar rutas en la status bar.
contextBridge.exposeInMainWorld('terminalHome', os.homedir());
