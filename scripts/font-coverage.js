/**
 * Guarda contra la regresión que rompió los marcos de las TUIs: verificar que las caras
 * vendoreadas de la mono cubran los rangos con los que una terminal se dibuja.
 *
 * Con el renderer DOM, xterm no dibuja ─ │ ╭ █ ░ por su cuenta (eso lo hace el addon
 * WebGL, que no usamos): los manda al span y elige fuente Chromium. Si la cara no los
 * trae, se caen a otra fuente con otro avance y los marcos salen despegados. Las caras
 * de Google Fonts vienen subseteadas al rango `latin` y no los traen — de ahí el bug.
 *
 * Lee el cmap sin dependencias. Sirve para .ttf/.otf y para .woff2 (el cmap no lleva
 * transform en woff2: alcanza con brotli-descomprimir y saltar a su offset).
 *
 *   node scripts/font-coverage.js                      # las caras del bundle
 *   node scripts/font-coverage.js otra-cara.woff2      # una en particular
 *
 * Sale con código 1 si a alguna cara le falta algo, así se puede colgar de un check.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** Tabla de tags conocidos de woff2; el índice en los flags apunta acá. */
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix'
];

/** Lo que una TUI necesita para dibujarse. Si algo de acá falta, hay fallback. */
const PROBES = [
  [0x2500, '─ box drawing'],
  [0x2502, '│ box vertical'],
  [0x250c, '┌ esquina'],
  [0x256d, '╭ esquina redondeada'],
  [0x2550, '═ doble'],
  [0x2571, '╱ diagonal'],
  [0x2580, '▀ half block'],
  [0x2588, '█ full block'],
  [0x2591, '░ light shade'],
  [0x2593, '▓ dark shade'],
  [0x259f, '▟ quadrant'],
  [0x25cf, '● bullet'],
  [0x2022, '• bullet chico'],
  [0x2026, '… elipsis'],
  [0x2713, '✓ check'],
  [0x2190, '← flecha'],
  [0x2800, '⠁ braille blank'],
  [0x280b, '⠋ braille spinner'],
  [0x2839, '⠹ braille spinner'],
  [0x28be, '⠾ braille']
];

/** Entero de ancho variable de woff2: 7 bits por byte, el bit alto marca continuación. */
function readBase128(buf, pos) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[pos.offset++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return value >>> 0;
  }
  throw new Error('UIntBase128 inválido');
}

/** Devuelve { data, tables } con los datos sin comprimir y el offset de cada tabla. */
function load(file) {
  const buf = fs.readFileSync(file);

  if (buf.toString('latin1', 0, 4) !== 'wOF2') {
    // sfnt plano (.ttf/.otf): el directorio ya apunta a offsets absolutos.
    const numTables = buf.readUInt16BE(4);
    const tables = {};
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      tables[buf.toString('latin1', rec, rec + 4)] = buf.readUInt32BE(rec + 8);
    }
    return { data: buf, tables };
  }

  // woff2: el directorio da longitudes, no offsets; las tablas van concatenadas
  // en ese mismo orden dentro del stream brotli, sin padding.
  const numTables = buf.readUInt16BE(12);
  const pos = { offset: 48 };
  const dir = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[pos.offset++];
    const index = flags & 0x3f;
    const version = (flags >> 6) & 0x03;
    const tag = index === 0x3f
      ? buf.toString('latin1', pos.offset, (pos.offset += 4))
      : KNOWN_TAGS[index];
    const origLength = readBase128(buf, pos);
    // glyf/loca invierten el criterio: para ellas la versión 0 SÍ es transformada.
    const isGlyfLoca = tag === 'glyf' || tag === 'loca';
    const transformed = isGlyfLoca ? version === 0 : version !== 0;
    dir.push({ tag, length: transformed ? readBase128(buf, pos) : origLength });
  }

  const compressedLength = buf.readUInt32BE(20);
  const data = zlib.brotliDecompressSync(
    buf.subarray(pos.offset, pos.offset + compressedLength)
  );

  const tables = {};
  let acc = 0;
  for (const t of dir) {
    tables[t.tag] = acc;
    acc += t.length;
  }
  return { data, tables };
}

/** Rangos [inicio, fin] cubiertos, leyendo las subtablas cmap formato 4 y 12. */
function coveredRanges(data, cmapOffset) {
  const numSubtables = data.readUInt16BE(cmapOffset + 2);
  const ranges = [];

  for (let i = 0; i < numSubtables; i++) {
    const record = cmapOffset + 4 + i * 8;
    const sub = cmapOffset + data.readUInt32BE(record + 4);
    const format = data.readUInt16BE(sub);

    if (format === 4) {
      const segCountX2 = data.readUInt16BE(sub + 6);
      const endOffset = sub + 14;
      const startOffset = endOffset + segCountX2 + 2; // +2: el reservedPad del medio
      for (let s = 0; s < segCountX2 / 2; s++) {
        const end = data.readUInt16BE(endOffset + s * 2);
        const start = data.readUInt16BE(startOffset + s * 2);
        if (start !== 0xffff) ranges.push([start, end]);
      }
    } else if (format === 12) {
      const numGroups = data.readUInt32BE(sub + 12);
      for (let g = 0; g < numGroups; g++) {
        const group = sub + 16 + g * 12;
        ranges.push([data.readUInt32BE(group), data.readUInt32BE(group + 4)]);
      }
    }
  }

  return ranges.sort((a, b) => a[0] - b[0]);
}

function check(file) {
  const { data, tables } = load(file);
  const ranges = coveredRanges(data, tables['cmap']);
  const covers = (cp) => ranges.some(([a, b]) => cp >= a && cp <= b);

  const unitsPerEm = data.readUInt16BE(tables['head'] + 18);
  const advance = data.readInt16BE(tables['OS/2'] + 2);
  const missing = PROBES.filter(([cp]) => !covers(cp));

  const name = path.basename(file);
  const em = (advance / unitsPerEm).toFixed(4);
  if (missing.length === 0) {
    console.log(`  ok    ${name.padEnd(30)} ${ranges.length} rangos · ${em} em`);
  } else {
    console.log(`  FALTA ${name.padEnd(30)} ${ranges.length} rangos · ${em} em`);
    for (const [, label] of missing) console.log(`          sin ${label}`);
  }
  return { ok: missing.length === 0, em, file };
}

const args = process.argv.slice(2);
const dir = path.join(__dirname, '..', 'src', 'renderer', 'fonts');

// Todas las fuentes del bundle, no sólo JetBrains Mono. La cobertura es
// cross-fuente: Noto Sans Symbols 2 cubre braille, JetBrains Mono cubre el
// resto. Lo que importa es que el BUNDLE entero cubra todos los probes.
const allFontFiles = args.length
  ? args
  : fs.readdirSync(dir)
      .filter((f) => /\.(ttf|otf|woff2)$/.test(f))
      .map((f) => path.join(dir, f));

// Sólo las caras de JetBrains Mono para el chequeo de avance uniforme
const jbFiles = allFontFiles.filter((f) => /^jetbrains-mono-/.test(path.basename(f)));

if (allFontFiles.length === 0) {
  console.error('No hay fuentes en src/renderer/fonts.');
  process.exit(1);
}

console.log('\nCobertura del bundle (renderer DOM: sin estos rangos hay fallback)\n');

// 1) Reporte por cara individual
console.log('— Por cara —');
const results = allFontFiles.map(check);

// 2) Cobertura cross-fuente: el union de todos los cmap del bundle
const allRanges = [];
for (const file of allFontFiles) {
  const { data, tables } = load(file);
  const ranges = coveredRanges(data, tables['cmap']);
  allRanges.push(...ranges);
}
allRanges.sort((a, b) => a[0] - b[0]);
const bundleCovers = (cp) => allRanges.some(([a, b]) => cp >= a && cp <= b);

const bundleMissing = PROBES.filter(([cp]) => !bundleCovers(cp));
console.log('\n— Bundle completo —');
if (bundleMissing.length === 0) {
  console.log('  ok    Todos los probes cubiertos por el bundle.');
} else {
  console.log('  FALTA probes sin cobertura en NINGUNA fuente del bundle:');
  for (const [, label] of bundleMissing) console.log(`          sin ${label}`);
}

// 3) Avance uniforme entre caras de JetBrains Mono (si una cara tiene otro
// advance, la grilla se desalinea al pasar de normal a bold/italic)
const jbResults = results.filter((r) => jbFiles.includes(r.file || ''));
const advances = new Set(jbResults.map((r) => r.em));
if (advances.size > 1) {
  console.log(`\n  FALTA  las caras de JetBrains Mono no comparten avance: ${[...advances].join(', ')} em`);
}

const ok = bundleMissing.length === 0 && advances.size <= 1;
console.log(ok ? '\nTodo cubierto.\n' : '\nHay caras incompletas: las TUIs van a caer a otra fuente.\n');
process.exit(ok ? 0 : 1);
