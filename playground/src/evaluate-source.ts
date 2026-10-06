import ts from 'typescript';
import type { CompiledProcessor } from '@unworklet/core';

export function evaluateSource(source: string, modules: Record<string, unknown>) {
  const result = ts.transpileModule(source, {
    fileName: 'example.processor.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const error = result.diagnostics?.find(d => d.category === ts.DiagnosticCategory.Error);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  const record = { exports: {} as Record<string, unknown> };
  const require = (name: string) => {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unsupported import: ${name}. Use a public den entry or @unworklet/core.`);
    return modules[name];
  };
  // This runs only in a disposable compilation worker, never on the UI/audio thread.
  const execute = new Function('require', 'module', 'exports', result.outputText);
  execute(require, record, record.exports);
  const processor = record.exports.default as CompiledProcessor<unknown> | undefined;
  if (!processor || typeof processor !== 'object' || !('worklet' in processor)) throw new Error('Export an unworklet CompiledProcessor as default.');
  return { processor, exports: record.exports };
}
