// ntermx — renderer: xterm.js con tabs (una pty por tab) + cursor glow.
// Globals de los bundles UMD cargados en index.html:
//   window.Terminal, window.FitAddon, window.WebLinksAddon

const MAX_TABS = 4;

/** @type {{tabs: any[], activeId: number|null}} */
const state = { tabs: [], activeId: null };
let tabSeq = 0;

// ---- Tema estilo Console: fondo transparente para que se vea la grilla cyan ----
const NEON_THEME = {
  background: 'rgba(10,10,15,0)',
  foreground: '#e0e0f0',
  cursor: '#00fff5',
  cursorAccent: '#0a0a0f',
  selectionBackground: 'rgba(0,255,245,.22)',
  black:   '#0a0a0f',
  red:     '#ff0044',
  green:   '#00ff88',
  yellow:  '#ffee00',
  blue:    '#0088ff',
  magenta: '#ff00aa',
  cyan:    '#00fff5',
  white:   '#e0e0f0',
  brightBlack:   '#555577',
  brightRed:     '#ff5577',
  brightGreen:   '#55ffaa',
  brightYellow:  '#ffee55',
  brightBlue:    '#55aaff',
  brightMagenta: '#ff55cc',
  brightCyan:    '#55ffff',
  brightWhite:   '#ffffff',
};

const containerEl = document.getElementById('terminal-container');
const tabsEl = document.getElementById('tabs');

// ===========================================================================
// Arranque
// ===========================================================================
(async () => {
  // Esperamos la web font ANTES de crear la primera shell: si xterm mide la celda
  // con la fuente de fallback, la grilla queda corrida.
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch { /* noop */ }
  }
  initTooltips();
  wireGlobalUi();
  initUpdates();
  createTab();
  setStatusTime();
  setInterval(setStatusTime, 1000);
})();

// ===========================================================================
// Tabs
// ===========================================================================
function createTab() {
  if (state.tabs.length >= MAX_TABS) return;

  const id = ++tabSeq;
  const el = document.createElement('div');
  el.className = 'term-instance';
  containerEl.appendChild(el);

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Noto Sans Symbols 2', 'Cascadia Code', monospace",
    fontSize: 14,
    // lineHeight 1.02 (no 1, no 1.2). Con el renderer DOM la celda ES la caja del
    // glifo: un ▀ o un █ llenan su em box y nada más, así que todo lo que la celda
    // mida de más queda como banda muerta ENTRE filas y parte al medio cualquier arte
    // de bloques (el logo de Claude Code, las barras de progreso, los marcos de las
    // TUIs). Con WebGL esto no pasaba: el addon estira el path del glifo a la celda,
    // mida lo que mida. En 1 los bloques tilean sin costura y las verticales se tocan.
    // Pero JetBrains Mono tiene un ascender/descender ratio asimétrico: con lineHeight
    // exactamente 1, en algunos DPI (especialmente >150% scaling) quedaba un micro-gap
    // de ~1px entre filas que cortaba las verticales de los marcos TUI. El 2% extra
    // compensa el leading interno sin introducir una banda visible.
    lineHeight: 1.02,
    fontWeight: 500,
    fontWeightBold: 700,
    theme: NEON_THEME,
    // El cursor arranca invisible (inactiveStyle 'none', sin foco) y lo revelamos
    // recién junto con su glow — ver positionGlow. Evita el "agujero" en (0,0)
    // antes de que el shell escriba el primer prompt.
    cursorStyle: 'block',
    cursorInactiveStyle: 'none',
    cursorBlink: false,
    allowTransparency: true,
    scrollback: 10000,
    convertEol: false,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch { /* noop */ }

  const tab = {
    id, el, term, fitAddon,
    ptyId: null,
    cwd: '',
    // Compuertas del glow (ver positionGlow)
    shellStarted: false,
    cursorHidden: false,
    cursorRevealed: false,
  };
  state.tabs.push(tab);

  // Renderer DOM a propósito, NO WebGL. El renderer WebGL rasteriza cada glifo a un
  // atlas de texturas y ahí rompe las ITÁLICAS: al glifo inclinado le come la parte de
  // arriba, así que las letras que son puro cuerpo bajo (i, o) quedan chicas y pegadas
  // a la línea de base — se leen como subíndices. Se nota en la sombra del
  // autocompletado de PSReadLine, que llega como ESC[97;2;3m (el 3 es itálica).
  // No es la fuente: en HTML puro la misma cara itálica se dibuja perfecta, y las
  // métricas de la itálica son idénticas a las de la romana. Tampoco lo arreglan el
  // peso, letterSpacing, lineHeight, allowTransparency ni subir a xterm 6 + webgl 0.19.
  // El renderer DOM no pasa por el atlas: la itálica sale bien y además el texto gana
  // antialiasing subpixel. Se paga con el dibujado por GPU.
  //
  // Y con una segunda cosa, menos obvia: el addon WebGL es el que trae tryDrawCustomChar
  // + box/block/powerlineDefinitions, o sea el que DIBUJA ─ │ ╭ █ ░ como paths propios
  // calzados a la celda. El core (renderer DOM) no tiene nada de eso: mete el carácter
  // en un span y deja elegir fuente a Chromium. Por eso acá la fuente tiene que cubrir
  // esos rangos sí o sí — ver la nota larga en fonts.css. Lo único que JetBrains Mono
  // NO trae es braille (U+2800–28FF), que algunos spinners de CLI usan: eso lo cubre
  // Noto Sans Symbols 2, vendoreada en el bundle (ver fonts.css). No se despega porque
  // es 1 carácter suelto, no arte conectado; si algún día molesta, la salida es volver
  // a WebGL, no cambiar de fuente.
  term.open(el);

  setActiveTab(id);   // activa (y hace visible) antes de medir
  fitTab(tab);
  remeasure(tab);

  attachGlow(tab);
  attachOsc7(tab);
  attachKeys(tab);

  term.onData((data) => {
    if (tab.ptyId !== null) window.terminal.write(tab.ptyId, data);
  });

  window.terminal.spawn({ cols: term.cols, rows: term.rows }).then((info) => {
    tab.ptyId = info.id;
    if (info.isPs7) document.getElementById('status-shell').textContent = 'pwsh · 7';
    // El spawn es async: puede haber entrado un resize mientras tanto.
    window.terminal.resize(tab.ptyId, term.cols, term.rows);
  });

  renderTabs();
  return tab;
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = state.tabs[idx];

  // Cerrar la última cierra la ventana (que en realidad se esconde en el tray).
  if (state.tabs.length === 1) {
    window.app.close();
    return;
  }

  if (tab.ptyId !== null) window.terminal.kill(tab.ptyId);
  state.tabs.splice(idx, 1);

  // El panel de la terminal y el chip de la barra son dos elementos distintos, y cada
  // uno se va con SU animación. El panel se iba con la del chip, que vive en otra parte
  // del DOM — y encima nunca llegaba a hacer su fade: el splice de arriba ya lo sacó de
  // state.tabs, así que el toggle de setActiveTab (que sólo recorre state.tabs) no lo
  // alcanzaba y el panel se quedaba con .active, o sea a opacity 1. Como todas las
  // instancias son absolute sobre el mismo inset, el prompt que se iba quedaba pintado
  // encima del que entraba hasta que el chip terminara de animar.
  let dropped = false;
  const drop = () => {
    if (dropped) return;
    dropped = true;
    try { tab.term.dispose(); } catch { /* noop */ }
    tab.el.remove();
  };

  // Sacarle .active dispara su fade de salida: la misma transición de opacity que ya
  // hace el cross-fade al cambiar de tab, que es justo la que se sentía bien al abrir.
  // Desmontamos cuando termina la suya, no la del chip. Si la tab cerrada no era la
  // visible ya está en opacity 0: no hay transición, no va a haber transitionend, y la
  // desmontamos derecho (invisible como está, nadie ve el corte).
  const wasVisible = tab.el.classList.contains('active');
  tab.el.classList.remove('active');
  if (wasVisible) {
    tab.el.addEventListener('transitionend', drop, { once: true });
    // Red de seguridad: sin repaint (ventana escondida en el tray) la transición no
    // corre y transitionend no llega nunca — sin esto quedaría un term sin dispose.
    setTimeout(drop, 400);
  } else {
    drop();
  }

  // El chip se va con la suya y se desmonta solo, ya sin arrastrar al panel.
  const node = tabsEl.querySelector(`[data-tab="${id}"]`);
  if (node) {
    node.classList.add('tab-leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  }

  if (state.activeId === id) {
    setActiveTab(state.tabs[Math.min(idx, state.tabs.length - 1)].id);
  }
  renderTabs();
}

function setActiveTab(id) {
  state.activeId = id;
  for (const t of state.tabs) t.el.classList.toggle('active', t.id === id);
  const tab = getActive();
  if (tab) {
    fitTab(tab);
    tab.term.focus();
    updateStatusCwd();
  }
  renderTabs();
}

function getActive() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

function renderTabs() {
  // Reconciliamos contra el DOM en vez de recrear todo, para no cortar la animación
  // de entrada de una tab recién creada ni perder la de salida en curso.
  const seen = new Set();
  for (const tab of state.tabs) {
    seen.add(String(tab.id));
    let node = tabsEl.querySelector(`[data-tab="${tab.id}"]`);
    if (!node) {
      node = document.createElement('div');
      node.className = 'tab tab-entering';
      node.dataset.tab = String(tab.id);
      node.innerHTML =
        '<span class="tab-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg></span>' +
        '<span class="tab-name"></span>' +
        '<span class="tab-close"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></span>';
      node.addEventListener('click', (e) => {
        if (e.target.closest('.tab-close')) { closeTab(tab.id); return; }
        setActiveTab(tab.id);
      });
      node.addEventListener('animationend', () => node.classList.remove('tab-entering'), { once: true });
      tabsEl.appendChild(node);
    }
    node.classList.toggle('active', tab.id === state.activeId);
    const name = node.querySelector('.tab-name');
    // Numeradas como en Console, con un contador que NO se reusa: si cerrás la Shell 2
    // de [1,2,3] quedan "Shell 1" y "Shell 3" en vez de renumerarse bajo los pies.
    const label = `Shell ${tab.id}`;
    if (name.textContent !== label) name.textContent = label;
    // El nombre ya no dice dónde estás parado, así que el cwd va al tooltip.
    node.dataset.tip = tab.cwd || 'pwsh';
  }
  // Los nodos de tabs que ya no existen y no están animando su salida.
  tabsEl.querySelectorAll('.tab').forEach((n) => {
    if (!seen.has(n.dataset.tab) && !n.classList.contains('tab-leaving')) n.remove();
  });

  const plus = document.getElementById('new-tab');
  const atLimit = state.tabs.length >= MAX_TABS;
  plus.classList.toggle('at-limit', atLimit);
  plus.dataset.tip = atLimit
    ? `Shell limit reached (${MAX_TABS})`
    : 'New shell (Ctrl+Shift+T)';
}

// ===========================================================================
// Medición / fit
// ===========================================================================
function fitTab(tab) {
  try {
    tab.fitAddon.fit();
    if (tab.ptyId !== null) window.terminal.resize(tab.ptyId, tab.term.cols, tab.term.rows);
  } catch { /* durante el layout inicial puede no medir todavía */ }
}

/**
 * Red de seguridad para el race de la web font. fitAddon.fit() recomputa la grilla con
 * las métricas de celda YA cacheadas, así que si xterm midió el glifo con el fallback,
 * fitear no alcanza: hay que RE-MEDIR. Tocar una opción de fuente dispara el
 * CharSizeService, que vuelve a medir con la fuente real; recién ahí fiteamos.
 */
function remeasure(tab) {
  const run = () => {
    try {
      const ff = tab.term.options.fontFamily;
      tab.term.options.fontFamily = ff + ', monospace'; // cambio real → gatilla re-measure
      tab.term.options.fontFamily = ff;                 // lo devolvemos, ya re-medido
      fitTab(tab);
    } catch { /* noop */ }
  };
  requestAnimationFrame(run);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(run);
}

// ===========================================================================
// Cursor glow
// ===========================================================================
/**
 * Un div sigue al cursor y le pone el halo cyan. Va aparte del cursor que dibuja xterm
 * en vez de ser un box-shadow sobre él: así el halo se posiciona por coordenadas de
 * celda y no depende de cómo el renderer de turno materialice el cursor.
 *
 * Lo delicado es CUÁNDO mostrarlo: el halo no puede quedar flotando sin el bloque
 * adentro. Se oculta si (a) la shell todavía no escribió nada, (b) el cursor está en el
 * origen 0,0 con la terminal vacía —o sea, sin prompt aún—, (c) la app de turno escondió
 * el cursor (DECTCEM: spinners de CLIs, TUIs como vim/less), (d) estamos scrolleados en
 * el historial, o (e) hay una selección activa.
 */
function attachGlow(tab) {
  const glowEl = document.createElement('div');
  glowEl.className = 'cursor-glow';
  const term = tab.term;

  const positionGlow = () => {
    const screenEl = tab.el.querySelector('.xterm-screen');
    if (!screenEl) return;
    if (glowEl.parentNode !== screenEl) screenEl.appendChild(glowEl);

    const buf = term.buffer.active;
    const atOrigin = buf.cursorX === 0 && buf.cursorY === 0; // terminal vacía / sin prompt
    if (!tab.shellStarted || atOrigin || tab.cursorHidden ||
        buf.viewportY !== buf.baseY || term.hasSelection()) {
      glowEl.style.display = 'none';
      return;
    }

    // Revelamos el cursor recién en el primer frame en que el glow se muestra: así el
    // bloque y su halo aparecen SIEMPRE juntos, nunca uno sin el otro. Una vez por tab.
    if (!tab.cursorRevealed) {
      tab.cursorRevealed = true;
      term.options.cursorInactiveStyle = 'block'; // de acá en más se ve con y sin foco
      if (tab.id === state.activeId) term.focus();
    }

    const cw = screenEl.clientWidth / term.cols;
    const ch = screenEl.clientHeight / term.rows;
    glowEl.style.display = 'block';
    glowEl.style.left = (buf.cursorX * cw) + 'px';
    glowEl.style.top = (buf.cursorY * ch) + 'px';
    glowEl.style.width = cw + 'px';
    glowEl.style.height = ch + 'px';
  };

  tab.positionGlow = positionGlow;
  term.onCursorMove(positionGlow);
  term.onRender(positionGlow);
  term.onSelectionChange(positionGlow);
  requestAnimationFrame(positionGlow);

  // DECTCEM (ESC[?25h / ESC[?25l): las apps que esconden el cursor sacan el bloque que
  // dibuja xterm. El glow lo posicionamos nosotros, así que sin esto quedaba el halo
  // flotando vacío. Devolvemos false para que xterm igual procese el hide/show real.
  try {
    const setHidden = (hidden) => { tab.cursorHidden = hidden; positionGlow(); };
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(25)) setHidden(false);
      return false;
    });
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.includes(25)) setHidden(true);
      return false;
    });
  } catch (e) {
    console.warn('[NTERMX] no pude registrar el handler CSI ?25:', e && e.message);
  }
}

// ===========================================================================
// OSC 7 (cwd) — lo emite src/prompt.ps1 en cada prompt
// ===========================================================================
function attachOsc7(tab) {
  try {
    tab.term.parser.registerOscHandler(7, (payload) => {
      let p = payload || '';
      try { p = decodeURIComponent(p.replace(/^file:\/\/\/?/, '')); } catch { /* noop */ }
      tab.cwd = p.replace(/\//g, '\\');
      if (tab.id === state.activeId) updateStatusCwd();
      renderTabs();
      return false;
    });
  } catch (e) {
    console.warn('[NTERMX] no pude registrar el handler OSC 7:', e && e.message);
  }
}

// ===========================================================================
// Teclado
// ===========================================================================
function attachKeys(tab) {
  tab.term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;

    // Nueva shell
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') { createTab(); return false; }
    // Cerrar la shell del tab actual
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyW') { closeTab(tab.id); return false; }
    // Ciclar tabs
    if (e.ctrlKey && e.code === 'Tab') {
      const i = state.tabs.findIndex((t) => t.id === state.activeId);
      if (i !== -1 && state.tabs.length > 1) {
        const next = e.shiftKey
          ? (i - 1 + state.tabs.length) % state.tabs.length
          : (i + 1) % state.tabs.length;
        setActiveTab(state.tabs[next].id);
      }
      return false;
    }
    // Ctrl+C: copiar si hay selección; si no, que siga de largo como SIGINT.
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyC') {
      const sel = tab.term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        tab.term.clearSelection();
        return false;
      }
    }
    // Ctrl+V NO se intercepta a propósito: xterm ya pega vía el evento `paste` nativo
    // del textarea. Manejarlo acá además pegaba TODO dos veces (devolver false en el
    // keydown no cancela el paste del navegador, son eventos independientes).
    return true;
  });
}

// ===========================================================================
// UI global
// ===========================================================================
function wireGlobalUi() {
  document.getElementById('new-tab').addEventListener('click', () => createTab());
  document.getElementById('win-min').addEventListener('click', () => window.app.minimize());
  document.getElementById('win-close').addEventListener('click', () => window.app.close());

  // Botón maximizar/restaurar: el ícono y el tooltip los dicta el estado real de
  // la ventana, que nos llega desde main vía onMaximizeState. Click siempre
  // togglea — nunca asumimos estado.
  const winMax = document.getElementById('win-max');
  winMax.addEventListener('click', () => window.app.toggleMaximize());
  window.app.onMaximizeState((maximized) => {
    winMax.classList.toggle('maximized', !!maximized);
    winMax.setAttribute('data-tip', maximized ? 'Restore' : 'Maximize');
  });

  window.terminal.onData(({ id, data }) => {
    const tab = state.tabs.find((t) => t.ptyId === id);
    if (!tab) return;
    tab.term.write(data);
    tab.shellStarted = true; // primer output: abre la compuerta del glow
  });

  window.terminal.onExit(({ id, exitCode }) => {
    const tab = state.tabs.find((t) => t.ptyId === id);
    if (!tab) return;
    tab.ptyId = null;
    tab.term.write(`\r\n\x1b[38;2;255;0;68m[process exited with code ${exitCode}]\x1b[0m\r\n`);
  });

  // Foco a nivel SO (alt-tab, click en taskbar, restore desde el tray): se lo pasamos
  // al xterm del tab activo, porque el focus del DOM se pierde con frameless + DWM.
  window.app.onFocus(() => {
    const tab = getActive();
    if (tab) tab.term.focus();
  });

  window.addEventListener('resize', () => {
    for (const t of state.tabs) fitTab(t);
  });
}

// ===========================================================================
// Status bar
// ===========================================================================
function updateStatusCwd() {
  const tab = getActive();
  const el = document.getElementById('status-cwd');
  if (el) el.textContent = tab && tab.cwd ? shortenPath(tab.cwd) : '~';
}

function setStatusTime() {
  const el = document.getElementById('status-time');
  if (!el) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  el.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shortenPath(p) {
  if (!p) return '~';
  const home = (window.terminalHome || '').toLowerCase().replace(/\//g, '\\');
  if (home && p.toLowerCase().startsWith(home)) return '~' + p.slice(home.length);
  const parts = p.split('\\').filter(Boolean);
  if (parts.length <= 2) return p;
  return '…\\' + parts.slice(-2).join('\\');
}

// ===========================================================================
// Tooltips propios (nada del title nativo de Chromium)
// ===========================================================================
function initTooltips() {
  const tip = document.createElement('div');
  tip.id = 'tooltip';
  document.body.appendChild(tip);

  let timer = null;
  const hide = () => {
    clearTimeout(timer);
    tip.classList.remove('show');
  };

  document.addEventListener('mouseover', (e) => {
    const host = e.target.closest('[data-tip]');
    if (!host) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      tip.textContent = host.dataset.tip;
      tip.classList.remove('above');
      tip.classList.add('show');
      // Posicionado después de tener texto, así medimos el tamaño real.
      const r = host.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      let left = r.left + r.width / 2 - t.width / 2;
      left = Math.max(6, Math.min(left, window.innerWidth - t.width - 6));
      let top = r.bottom + 7;
      if (top + t.height > window.innerHeight - 6) {
        top = r.top - t.height - 7;
        tip.classList.add('above');
      }
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }, 420);
  });

  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tip]')) hide();
  });
  document.addEventListener('mousedown', hide);
}

// ===========================================================================
// Auto-update — toast + versión clickeable en la status bar
// ===========================================================================
/* Un solo nodo que muta de fase en vez de una caja por estado. Mientras baja la
   descarga sólo movemos el ancho de la barra (sin reconstruir el contenido) para que la
   animación de width sea continua. Los chequeos automáticos (manual=false) que no traen
   novedad se silencian; los que pediste vos siempre dan respuesta, aunque sea "al día". */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const UT_SVG = {
  rocket: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
  down: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  alert: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  spin: '<svg class="ut-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>',
  restart: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  x: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

const updateToast = {
  _node: null,
  _hideTimer: 0,
  _endMorph: null,
  get node() { return this._node || (this._node = document.getElementById('update-toast')); },
  render(inner, variant) {
    const n = this.node; if (!n) return;
    clearTimeout(this._hideTimer);

    // ¿Es una entrada (toast oculto/vacío) o una mutación de uno ya visible?
    const visible = n.classList.contains('show') && n.innerHTML !== '';
    const fromH = visible ? n.getBoundingClientRect().height : 0;
    this._stopMorph();

    n.classList.remove('ready', 'error');
    if (variant) n.classList.add(variant);
    n.innerHTML = inner;

    if (!visible) {
      // Entrada: forzamos un reflow para que el estado "oculto" (opacity 0 + translateX)
      // quede comprometido ANTES de agregar .show; si no, el navegador junta los dos
      // frames en uno y la caja aparece de golpe en vez de deslizarse.
      void n.offsetWidth;
      n.classList.add('show');
      return;
    }

    // Mutación: el contenido nuevo ya define el alto final; interpolamos desde el viejo.
    const toH = n.getBoundingClientRect().height;
    if (Math.round(fromH) === Math.round(toH)) return; // mismo alto: nada que animar
    n.style.height = fromH + 'px';
    n.classList.add('morphing');
    void n.offsetHeight; // comprometer el alto viejo con la transición ya activa
    n.style.height = toH + 'px';
    this._endMorph = (e) => {
      if (e && e.propertyName !== 'height') return;
      this._stopMorph();
    };
    n.addEventListener('transitionend', this._endMorph);
  },
  // Vuelve a height:auto. Idempotente: lo llaman el transitionend, el próximo render y dismiss().
  _stopMorph() {
    const n = this.node; if (!n) return;
    if (this._endMorph) { n.removeEventListener('transitionend', this._endMorph); this._endMorph = null; }
    n.classList.remove('morphing');
    n.style.height = '';
  },
  autoDismiss(ms) {
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.dismiss(), ms);
  },
  dismiss() {
    const n = this.node; if (!n) return;
    clearTimeout(this._hideTimer);
    this._stopMorph(); // que un morph a medio camino no deje el alto clavado en px
    n.classList.remove('show');
    // Vaciamos el contenido recién cuando terminó la transición de salida, así no se
    // desarma la caja delante de los ojos mientras todavía se está yendo.
    this._hideTimer = setTimeout(() => {
      if (!n.classList.contains('show')) { n.innerHTML = ''; updateToastPhase = null; }
    }, 340);
  },
};
let updateToastPhase = null;

function utRow(icon, label, title, sub, closable) {
  return (
    `<div class="ut-row">` +
      `<span class="ut-icon">${icon}</span>` +
      `<div class="ut-content">` +
        `<div class="ut-label">${label}</div>` +
        `<div class="ut-title">${title}</div>` +
        (sub ? `<div class="ut-sub">${sub}</div>` : '') +
      `</div>` +
      (closable ? `<button class="ut-close" data-ut="later" data-tip="Dismiss">${UT_SVG.x}</button>` : '') +
    `</div>`
  );
}

function renderUpdate(status) {
  const phase = status.phase;
  const version = status.version ? escapeHtml(String(status.version)) : '';
  const manual = !!status.manual;

  // Descarga en curso: sólo movemos la barra, para que la transición de width no se corte.
  if (phase === 'downloading' && updateToastPhase === 'downloading') {
    const pct = Math.max(0, Math.min(100, Math.round(status.percent || 0)));
    const bar = updateToast.node && updateToast.node.querySelector('.ut-progress-bar');
    const num = updateToast.node && updateToast.node.querySelector('.ut-pct');
    if (bar) bar.style.width = pct + '%';
    if (num) num.textContent = pct + '%';
    return;
  }
  updateToastPhase = phase;

  switch (phase) {
    case 'checking':
      if (!manual) return; // auto-check: callado hasta que haya novedad
      updateToast.render(utRow(UT_SVG.spin, 'Checking', 'Checking for updates…', '', false));
      break;
    case 'available':
      updateToast.render(
        utRow(UT_SVG.rocket, 'Update', `ntermx <b>v${version}</b> is available`, 'A new version is ready to download.', true) +
        `<div class="ut-actions">` +
          `<button class="ut-btn primary" data-ut="download">Download</button>` +
          `<button class="ut-btn ghost" data-ut="later">Later</button>` +
        `</div>`
      );
      break;
    case 'downloading': {
      const pct = Math.max(0, Math.min(100, Math.round(status.percent || 0)));
      updateToast.render(
        utRow(UT_SVG.down, 'Downloading', `Downloading update… <span class="ut-pct">${pct}%</span>`, '', false) +
        `<div class="ut-progress"><div class="ut-progress-bar" style="width:${pct}%"></div></div>`
      );
      break;
    }
    case 'downloaded':
      updateToast.render(
        utRow(UT_SVG.check, 'Ready', `ntermx <b>v${version}</b> downloaded`, 'Restart to finish installing.', true) +
        `<div class="ut-actions">` +
          `<button class="ut-btn primary" data-ut="install">Restart &amp; install</button>` +
          `<button class="ut-btn ghost" data-ut="later">Later</button>` +
        `</div>`,
        'ready'
      );
      break;
    case 'none':
      if (!manual) { updateToast.dismiss(); return; }
      updateToast.render(utRow(UT_SVG.check, 'Up to date', 'Already on the latest version.', '', true), 'ready');
      updateToast.autoDismiss(2800);
      break;
    case 'error':
      if (!manual) { updateToast.dismiss(); return; }
      updateToast.render(utRow(UT_SVG.alert, 'Update failed', escapeHtml(status.error || 'Couldn\'t check for updates.'), '', true), 'error');
      updateToast.autoDismiss(4200);
      break;
    case 'sim-install':
      updateToast.render(utRow(UT_SVG.restart, 'Installing', 'Restarting to install… (simulated in dev)', '', false), 'ready');
      updateToast.autoDismiss(2800);
      break;
  }
}

function initUpdates() {
  // La versión de la status bar: se rellena async y entra con un fade (ver el .ready
  // del CSS), y el click pide el chequeo a mano — manual=true, así también contesta
  // cuando NO hay nada nuevo, que es justo lo que querés saber si lo pediste vos.
  const vEl = document.getElementById('status-version');
  if (vEl) {
    window.app.getVersion()
      .then((v) => { vEl.textContent = 'v' + v; vEl.classList.add('ready'); })
      .catch(() => { /* sin versión, el item queda invisible y no molesta */ });
    vEl.addEventListener('click', () => window.updater.check(true));
  }

  window.updater.onStatus(renderUpdate);

  // Delegación de clicks del toast: descargar / instalar / descartar.
  const toast = updateToast.node;
  if (toast) {
    toast.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ut]');
      if (!btn) return;
      const act = btn.dataset.ut;
      if (act === 'download') {
        window.updater.download();
        renderUpdate({ phase: 'downloading', percent: 0 }); // feedback inmediato al click
      } else if (act === 'install') {
        window.updater.install();
      } else {
        updateToast.dismiss();
      }
    });
  }
}
