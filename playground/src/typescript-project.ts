import ts from 'typescript';

export type TypeFiles = { files: Record<string, string>; packages: Record<string, { version: string; exports?: Record<string, unknown> }> };
export type Diagnostic = { start: number; length: number; message: string; code: number; severity: 'error' | 'warning' };
export function createTypeProject(snapshot: TypeFiles) {
  let source = '', version = 0;
  const filename = '/project/example.processor.ts';
  const files = snapshot.files;
  const directories = new Set<string>();
  for (const name of Object.keys(files)) {
    const parts = name.split('/');
    while (parts.length > 1) { parts.pop(); directories.add(parts.join('/') || '/'); }
  }
  const normalize = (name: string) => {
    const parts: string[] = [];
    for (const part of name.split('/')) if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
    return '/' + parts.join('/');
  };
  const read = (name: string) => normalize(name) === filename ? source : files[normalize(name)];
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
    noEmit: true, allowImportingTsExtensions: true, skipLibCheck: false,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'], types: [],
  };
  const cached = new Map<string, ts.IScriptSnapshot>();
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => [filename],
    getScriptVersion: name => name === filename ? String(version) : '0',
    getProjectVersion: () => String(version),
    getScriptSnapshot(name) {
      const text = read(name); if (text === undefined) return undefined;
      if (name === filename) return ts.ScriptSnapshot.fromString(text);
      let value = cached.get(name); if (!value) { value = ts.ScriptSnapshot.fromString(text); cached.set(name, value); } return value;
    },
    getCurrentDirectory: () => '/project',
    getDefaultLibFileName: () => '/project/node_modules/typescript/lib/lib.es2023.full.d.ts',
    fileExists: name => read(name) !== undefined,
    readFile: read,
    directoryExists: name => directories.has(normalize(name)),
    getDirectories: name => [...directories].filter(dir => dir.startsWith(normalize(name) + '/') && !dir.slice(normalize(name).length + 1).includes('/')),
    readDirectory: () => [],
    realpath: name => normalize(name),
    useCaseSensitiveFileNames: () => true,
  };
  const service = ts.createLanguageService(host);
  const sync = (text: string) => { if (text !== source) { source = text; version++; } };
  const diagnostics = (): Diagnostic[] => [...service.getSyntacticDiagnostics(filename), ...service.getSemanticDiagnostics(filename)].map(d => ({
    start: d.start ?? 0, length: d.length ?? 0, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'), code: d.code,
    severity: d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
  }));
  return { service, filename, compilerOptions, sync, diagnostics, dispose: () => service.dispose() };
}
