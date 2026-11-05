import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const modules = new Map();
export function moduleUrl(file) {
  const filename = path.resolve(file);
  if (modules.has(filename)) return modules.get(filename);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from ['"](\.\.?\/[^'"]+)['"]/g, (_match, relative) =>
    `from ${JSON.stringify(moduleUrl(path.resolve(path.dirname(filename), relative + '.ts')))}`);
  const url = 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64');
  modules.set(filename, url);
  return url;
}
