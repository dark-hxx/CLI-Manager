import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { UnicodeGraphemesAddon } = require('@xterm/addon-unicode-graphemes');
const cols = 40, rows = 8;
const definitions = [
  ['sgr', '\x1b[1;3;4;31mred\x1b[0m \x1b[38;2;20;100;200;48;5;17mRGB\x1b[0m'],
  ['unicode', '中文 A e\u0301 🙂 end\r\n第二行'],
  ['alternate', 'normal buffer\x1b[?1049h\x1b[2J\x1b[2;3Hvim 中文\x1b[?25l'],
  ['scroll-region', 'header\x1b[2;6r\x1b[6;1Hone\r\ntwo\r\nthree'],
  ['hyperlink', '\x1b]8;id=sample;https://example.invalid/\x1b\\link\x1b]8;;\x1b\\'],
  ['cursor-modes', 'cursor\x1b[?25l\x1b[?2004h\x1b[4;7H'],
  ['wrapping', 'x'.repeat(cols * 3 + 4)],
  ['wrap-pending', 'x'.repeat(cols)],
];
const write = (term, data) => new Promise(resolve => term.write(data, resolve));
function newTerm() {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  // Match the production default, before any input or replay.
  term.loadAddon(new UnicodeGraphemesAddon());
  return term;
}
function snapshot(term) {
  const buffer = term.buffer.active;
  const result = [];
  const color = (cell, prefix) => cell[`is${prefix}Default`]() ? 'default'
    : cell[`is${prefix}RGB`]() ? (() => {
      const c = cell[`get${prefix}Color`]();
      return `rgb:${c >>> 16 & 255},${c >>> 8 & 255},${c & 255}`;
    })() : `index:${cell[`get${prefix}Color`]()}`;
  for (let row = 0; row < rows; row++) {
    const line = buffer.getLine(buffer.baseY + row);
    result.push(Array.from({ length: cols }, (_, col) => {
      const cell = line.getCell(col);
      // Locked-version diagnostic only: the public cell API omits OSC 8 data.
      if (!cell.extended || !term._core._oscLinkService?.getLinkData) {
        throw new Error('Locked xterm OSC 8 inspection API is unavailable');
      }
      const link = cell.extended.urlId
        ? term._core._oscLinkService.getLinkData(cell.extended.urlId) : null;
      if (cell.extended.urlId && !link) throw new Error('Unresolved OSC 8 link');
      return { text: cell.getWidth() === 0 ? '' : cell.getChars() || ' ', width: cell.getWidth(),
        fg: color(cell, 'Fg'), bg: color(cell, 'Bg'),
        hyperlink: link ? { id: link.id ?? null, uri: link.uri } : null,
        attrs: ['isBold', 'isItalic', 'isDim', 'isUnderline', 'isInverse', 'isInvisible', 'isStrikethrough']
          .map(name => !!cell[name]()) };
    }));
  }
  return { rows: result, cursor: [buffer.cursorX, buffer.cursorY],
    alternate: buffer.type === 'alternate', cursorVisible: !term._core.coreService.isCursorHidden,
    bracketedPaste: term.modes.bracketedPasteMode };
}
const fixtures = [], expected = [];
for (const [name, source] of definitions) {
  const term = newTerm();
  const addon = new SerializeAddon();
  term.loadAddon(addon);
  await write(term, source);
  fixtures.push({ name, cols, rows, ansi: addon.serialize() });
  expected.push(snapshot(term));
  term.dispose();
}
const binary = fileURLToPath(new URL(`../target/release/poc-checkpoint${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const run = spawnSync(binary, [], { input: JSON.stringify(fixtures), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
if (run.error) throw run.error;
if (run.status !== 0) throw new Error(`poc-checkpoint exit ${run.status}: ${run.stderr}`);
const parsed = JSON.parse(run.stdout);
// Separate parser compatibility from losses introduced by xterm serialization.
const directRun = spawnSync(binary, [], { input: JSON.stringify(definitions.map(([name, ansi]) =>
  ({ name, cols, rows, ansi }))), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
if (directRun.error) throw directRun.error;
if (directRun.status !== 0) throw new Error(`direct ANSI probe failed: ${directRun.status}`);
const direct = JSON.parse(directRun.stdout);
const continuationFor = name => name === 'alternate' ? '\x1b[?1049l'
  : name === 'scroll-region' ? '\x1b[6;1H\nnext' : 'Z';
function runCases(cases) {
  const run = spawnSync(binary, [], { input: JSON.stringify(cases), encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`Continuation probe exit ${run.status}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}
const continued = runCases(definitions.map(([name, ansi]) =>
  ({ name, cols, rows, ansi: ansi + continuationFor(name) })));
const serializedContinued = runCases(fixtures.map(fixture =>
  ({ ...fixture, ansi: fixture.ansi + continuationFor(fixture.name) })));
function cellDifferences(a, b) {
  const differences = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (!isDeepStrictEqual(a.rows[y][x], b.rows[y][x])) {
      differences.push({ x, y, expected: a.rows[y][x], actual: b.rows[y][x] });
    }
  }
  return { count: differences.length, first: differences.slice(0, 8) };
}
const links = state => state.rows.map(row => row.map(cell => cell.hyperlink));
const results = [];
for (let i = 0; i < fixtures.length; i++) {
  const term = newTerm();
  await write(term, parsed[i].ansi);
  const replay = snapshot(term);
  const continuation = continuationFor(fixtures[i].name);
  const serializedXterm = newTerm();
  await write(serializedXterm, fixtures[i].ansi);
  const xtermSerializationSnapshot = snapshot(serializedXterm);
  await write(serializedXterm, continuation);
  const directReverse = newTerm();
  await write(directReverse, direct[i].ansi);
  const directReverseSnapshot = snapshot(directReverse);
  await write(directReverse, continuation);
  const reference = newTerm();
  await write(reference, definitions[i][1]);
  await write(reference, continuation);
  await write(term, continuation);
  const mismatches = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (!isDeepStrictEqual(expected[i].rows[y][x], parsed[i].snapshot.rows[y][x])) {
      mismatches.push({ x, y, xterm: expected[i].rows[y][x], alacritty: parsed[i].snapshot.rows[y][x] });
    }
  }
  results.push({ name: fixtures[i].name,
    rawInputSnapshotMatches: isDeepStrictEqual(expected[i], direct[i].snapshot),
    rawInputDifferences: Object.keys(expected[i]).filter(key => !isDeepStrictEqual(expected[i][key], direct[i].snapshot[key])),
    rawInputCellDifferences: cellDifferences(expected[i], direct[i].snapshot),
    rawInputHyperlinkCells: direct[i].hyperlinkCells,
    cursorPositions: { xterm: expected[i].cursor, rawAlacritty: direct[i].snapshot.cursor,
      serializedXterm: xtermSerializationSnapshot.cursor, serializedAlacritty: parsed[i].snapshot.cursor },
    links: {
      rawParser: isDeepStrictEqual(links(expected[i]), links(direct[i].snapshot)),
      xtermSerialization: isDeepStrictEqual(links(expected[i]), links(xtermSerializationSnapshot)),
      directEncoder: isDeepStrictEqual(links(direct[i].snapshot), links(directReverseSnapshot)),
    },
    xtermToAlacritty: isDeepStrictEqual(expected[i], parsed[i].snapshot),
    alacrittyToXterm: isDeepStrictEqual(parsed[i].snapshot, replay),
    hyperlinkCells: parsed[i].hyperlinkCells,
    continuationEquivalent: isDeepStrictEqual(snapshot(reference), snapshot(term)),
    stages: {
      // Distinguish native parser differences from serialization and encoder losses.
      xtermSerializationSnapshot: isDeepStrictEqual(expected[i], xtermSerializationSnapshot),
      xtermSerializationContinuation: isDeepStrictEqual(snapshot(reference), snapshot(serializedXterm)),
      rawParserContinuation: isDeepStrictEqual(snapshot(reference), continued[i].snapshot),
      serializedParserContinuation: isDeepStrictEqual(snapshot(reference), serializedContinued[i].snapshot),
      directEncoderSnapshot: isDeepStrictEqual(direct[i].snapshot, directReverseSnapshot),
      directEncoderContinuation: isDeepStrictEqual(continued[i].snapshot, snapshot(directReverse)),
      directEncoderCellDifferences: cellDifferences(direct[i].snapshot, directReverseSnapshot),
    },
    mismatches: mismatches.slice(0, 8),
    // A snapshot alone never proves stateful continuation equivalence.
    activeViewportOnly: true,
    differences: Object.keys(expected[i]).filter(key => !isDeepStrictEqual(expected[i][key], parsed[i].snapshot[key])),
    reverseDifferences: Object.keys(replay).filter(key => !isDeepStrictEqual(replay[key], parsed[i].snapshot[key])),
  });
  term.dispose();
  reference.dispose();
  serializedXterm.dispose();
  directReverse.dispose();
}
const output = new URL('./results/checkpoint.json', import.meta.url);
await mkdir(new URL('./results/', import.meta.url), { recursive: true });
await writeFile(output, JSON.stringify({ at: new Date().toISOString(), cols, rows,
  fixtureVersion: 1, diagnosticVersion: 2, versions: { headless: require('@xterm/headless/package.json').version,
    serialize: require('@xterm/addon-serialize/package.json').version }, results,
  limitations: ['inactive buffer', 'scrollback', 'scroll margins', 'wrap pending', 'keyboard mode stacks',
    'OSC8 and cursor-hidden inspection use locked-version private xterm APIs'],
}, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
if (results.some(row => !row.rawInputSnapshotMatches || !row.xtermToAlacritty
    || !row.alacrittyToXterm || !row.continuationEquivalent
    || Object.values(row.links).some(value => value === false)
    || Object.values(row.stages).some(value => value === false))
    || results.find(row => row.name === 'hyperlink').hyperlinkCells === 0) process.exitCode = 1;
