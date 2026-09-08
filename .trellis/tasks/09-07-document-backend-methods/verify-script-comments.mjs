import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// 仅校验显式给出的 JS/TS 文件，不执行脚本或把内嵌字符串变化视为普通注释。
for (const file of process.argv.slice(2)) {
  assert(/\.(?:[cm]?js|tsx?)$/.test(file), `Unsupported script: ${file}`);
  const before = execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' });
  const after = readFileSync(file, 'utf8');
  const diff = execFileSync('git', ['diff', '--unified=0', '--', file], { encoding: 'utf8' });
  let addedComments = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    assert(!line.startsWith('-'), `${file}: removed source line`);
    if (line.startsWith('+')) {
      assert(/^\+\s*\/\/(?![/!])/.test(line), `${file}: non-ordinary-comment addition`);
      addedComments += 1;
    }
  }
  const kind = /\.tsx?$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  // 统一工作区与 Git 对象的物理换行，避免模板字符串 rawText 的 CRLF/LF 差异造成误报。
  const normalizedBefore = before.replace(/\r\n/g, '\n');
  const normalizedAfter = after.replace(/\r\n/g, '\n');
  const original = ts.createSourceFile(file, normalizedBefore, ts.ScriptTarget.Latest, true, kind);
  const current = ts.createSourceFile(file, normalizedAfter, ts.ScriptTarget.Latest, true, kind);
  assert.equal(original.parseDiagnostics.length, 0, `${file}: baseline parse error`);
  assert.equal(current.parseDiagnostics.length, 0, `${file}: current parse error`);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  assert.equal(printer.printFile(current), printer.printFile(original), `${file}: executable AST changed`);
  const methods = [];
  // 遍历语法树中的声明、方法、构造器及匿名回调，保留名称和行号供人工覆盖核对。
  function visit(node) {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
      || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node)) {
      methods.push({
        name: node.name?.getText(current) ?? (ts.isConstructorDeclaration(node) ? 'constructor' : '<anonymous>'),
        line: current.getLineAndCharacterOfPosition(node.getStart(current)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(current);
  console.log(JSON.stringify({ file, addedComments, methods, result: 'ordinary comments only; executable AST unchanged' }));
}
