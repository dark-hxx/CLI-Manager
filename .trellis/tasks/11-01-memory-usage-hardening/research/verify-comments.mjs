import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const files = execFileSync("git", ["diff", "--name-only", "-z"], { encoding: "utf8" }).split("\0")
  .filter(file => /\.(?:rs|tsx?|mjs)$/.test(file));
function comments(source, file) {
  if (file.endsWith(".rs")) return source.split(/\r?\n/).map(line => line.trim())
    .filter(line => /^(?:\/\/|\/\*|\*|\*\/)/.test(line));
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const regexStarts = new Set();
  function visit(node) {
    if (ts.isRegularExpressionLiteral(node)) regexStarts.add(node.getStart(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const result = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    // Slash tokens require parser context; regex bodies can contain apparent comments.
    if (regexStarts.has(scanner.getTokenPos())) token = scanner.reScanSlashToken();
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      result.push(scanner.getTokenText().replace(/\r\n/g, "\n"));
    }
  }
  return result;
}
const failures = [];
for (const file of files) {
  const before = comments(execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" }), file);
  const after = comments(readFileSync(file, "utf8"), file);
  let cursor = 0;
  for (const comment of before) {
    const index = after.indexOf(comment, cursor);
    if (index < 0) { failures.push(file); break; }
    cursor = index + 1;
  }
}
if (failures.length) { console.error("Comment preservation failed:", failures); process.exitCode = 1; }
else console.log(`Existing comments retained in ${files.length} modified source/test files.`);
