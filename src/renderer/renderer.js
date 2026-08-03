// Argon — renderer: xterm.js con tabs (una pty por tab) + cursor glow.
// Globals de los bundles UMD cargados en index.html:
//   window.Terminal, window.FitAddon, window.WebLinksAddon

const MAX_TABS = 8;

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
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    fontSize: 14,
    // lineHeight 1 (no 1.2) porque con el renderer DOM la celda ES la caja del glifo:
    // un ▀ o un █ llenan su em box y nada más, así que todo lo que la celda mida de más
    // queda como banda muerta ENTRE filas y parte al medio cualquier arte de bloques
    // (el logo de Claude Code, las barras de progreso, los marcos de las TUIs). Con
    // WebGL esto no pasaba: el addon estira el path del glifo a la celda, mida lo que
    // mida. En 1 los bloques tilean sin costura y las verticales de los marcos se tocan.
    lineHeight: 1,
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
  // NO trae es braille (U+2800–28FF), que algunos spinners de CLI usan: eso sigue
  // cayendo a Cascadia Code. Es 1 carácter suelto, no arte conectado, así que no se
  // despega; si algún día molesta, la salida es volver a WebGL, no cambiar de fuente.
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

  // La tab se va con su animación de salida; recién ahí desmontamos.
  const node = tabsEl.querySelector(`[data-tab="${id}"]`);
  const drop = () => {
    try { tab.term.dispose(); } catch { /* noop */ }
    tab.el.remove();
  };
  if (node) {
    node.classList.add('tab-leaving');
    node.addEventListener('animationend', () => { node.remove(); drop(); }, { once: true });
  } else {
    drop();
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
    ? `Llegaste al máximo de shells (${MAX_TABS})`
    : 'Nueva shell (Ctrl+Shift+T)';
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
    console.warn('[ARGON] no pude registrar el handler CSI ?25:', e && e.message);
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
    console.warn('[ARGON] no pude registrar el handler OSC 7:', e && e.message);
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
    tab.term.write(`\r\n\x1b[38;2;255;0;68m[el proceso terminó con código ${exitCode}]\x1b[0m\r\n`);
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
