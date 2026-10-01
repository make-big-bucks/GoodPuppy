import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const normalize = path => path.replaceAll('\\', '/');
const owner = path => normalize(path).match(/^src\/windows\/([^/]+)\//)?.[1];

export function dependencyViolations(filename, code) {
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true);
  const errors = [];
  const check = specifier => {
    if (!specifier.startsWith('.')) return;
    const target = normalize(relative(root, resolve(root, dirname(filename), specifier)));
    const from = normalize(filename);
    if (from.startsWith('src/shared/') && target.startsWith('src/windows/')) errors.push(`${from} → ${target}: shared cannot depend on windows`);
    if (owner(from) && owner(target) && owner(from) !== owner(target)) errors.push(`${from} → ${target}: windows cannot depend on another window`);
  };
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text);
      else errors.push(`${filename}: dynamic imports must have a literal target for dependency checks`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return errors;
}
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = sourceFiles(resolve(root, 'src')).flatMap(path => dependencyViolations(normalize(relative(root, path)), readFileSync(path, 'utf8')));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('PASS: shared and window dependency boundaries');
}
