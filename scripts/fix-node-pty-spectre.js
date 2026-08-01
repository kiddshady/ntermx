/**
 * Postinstall patch: remove the `SpectreMitigation: Spectre` requirement from
 * node-pty's gyp files so it can build against a stock VS 2022 install
 * (which typically lacks the optional "Spectre-mitigated" libraries).
 *
 * VS 2022 ships the C++ compiler but the Spectre libs are a separate,
 * opt-in component. node-pty forces Spectre on, which makes `MSBuild` fail
 * with `error MSB8040`. We turn it off; the binary still works fine.
 *
 * Runs automatically via the `postinstall` script in package.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules', 'node-pty');
const files = [
  'binding.gyp',
  path.join('deps', 'winpty', 'src', 'winpty.gyp')
];

let patched = 0;

for (const rel of files) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.log(`[fix-node-pty-spectre] skip (missing): ${rel}`);
    continue;
  }
  const original = fs.readFileSync(file, 'utf8');
  // Match the whole msvs_configuration_attributes block that enables Spectre.
  // Node-pty writes it consistently as:
  //     'msvs_configuration_attributes': {
  //         'SpectreMitigation': 'Spectre'
  //     },
  const pattern = /['"]msvs_configuration_attributes['"]\s*:\s*\{\s*['"]SpectreMitigation['"]\s*:\s*['"]Spectre['"]\s*\},?\s*\n?/g;
  if (!pattern.test(original)) {
    console.log(`[fix-node-pty-spectre] skip (already patched / no match): ${rel}`);
    continue;
  }
  const updated = original.replace(pattern, '');
  fs.writeFileSync(file, updated, 'utf8');
  patched++;
  console.log(`[fix-node-pty-spectre] patched: ${rel}`);
}

console.log(`[fix-node-pty-spectre] done (${patched} file(s) patched).`);
