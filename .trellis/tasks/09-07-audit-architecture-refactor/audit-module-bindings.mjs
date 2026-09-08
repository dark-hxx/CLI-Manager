import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Independent check of binding names and import evaluation order, not just graph edges.
const archive = '.trellis/tasks/archive/2026-09/09-07-architecture-convergence';
const { map, aliases } = JSON.parse(readFileSync(`${archive}/frontend-ownership-plan.json`, 'utf8'));
const edits = JSON.parse(readFileSync(`${archive}/frontend-path-edits.json`, 'utf8'));
const files = Object.keys(map).filter(file => !aliases[file] && file !== 'src/shared/types/remoteHandoff.ts');
const printer = ts.createPrinter({ removeComments: true });
const failures = [];
let checked = 0;
for (const file of files) {
  const before = execFileSync('git', ['show', `9488d0be:${file}`], { encoding: 'utf8', maxBuffer: 4e6 });
  let after = readFileSync(map[file], 'utf8');
  for (const edit of edits[file] ?? []) {
    after = after.replaceAll(`"${edit.after}"`, `"${edit.before}"`).replaceAll(`'${edit.after}'`, `'${edit.before}'`);
  }
  const cssMoves = {
    'src/components/desktop-pet/PetArtwork.tsx': ['src/components/desktop-pet/PetArtwork.css', 'src/features/desktop-pet/styles/PetArtwork.css', './PetArtwork.css', '../styles/PetArtwork.css'],
    'src/components/git/DiffViewerModal.tsx': ['src/components/git/diffViewer.css', 'src/features/git/styles/diffViewer.css', './diffViewer.css', '../styles/diffViewer.css'],
    'src/desktop-pet/DesktopPetApp.tsx': ['src/desktop-pet/desktopPet.css', 'src/features/desktop-pet/styles/desktopPet.css', './desktopPet.css', '../styles/desktopPet.css'],
  };
  if (cssMoves[file]) {
    const [oldFile, newFile, oldImport, newImport] = cssMoves[file];
    const oldCss = execFileSync('git', ['show', `9488d0be:${oldFile}`], { encoding: 'utf8' });
    assert.equal(readFileSync(newFile, 'utf8').replaceAll('\r\n', '\n'), oldCss.replaceAll('\r\n', '\n'));
    after = after.replace(`"${newImport}"`, `"${oldImport}"`);
  }
  if (file === 'src/lib/remoteHandoff.ts') {
    const oldType = ts.createSourceFile(file, before, ts.ScriptTarget.Latest, true).statements
      .find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'RemoteHandoffAgent');
    const typeFile = ts.createSourceFile('shared.ts', readFileSync('src/shared/types/remoteHandoff.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    assert.equal(typeFile.statements[0].getText(), oldType.getText());
    after = after.replace('import type { RemoteHandoffAgent } from "../shared/types/remoteHandoff";', '');
  }
  function imports(text) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    return source.statements.filter(ts.isImportDeclaration).map(node => printer.printNode(ts.EmitHint.Unspecified, node, source));
  }
  try { assert.deepEqual(imports(after), imports(before)); }
  catch { failures.push({ file, current: map[file], before: imports(before), after: imports(after) }); }
  checked++;
}
console.log(JSON.stringify({ checked, failures }, null, 2));
process.exitCode = failures.length ? 1 : 0;
