/// <reference types="vite/client" />
declare module 'virtual:den-types' { const snapshot: import('./src/typescript-project.ts').TypeFiles; export default snapshot; }
declare module 'virtual:den-modules' { const registry: Record<string, unknown>; export default registry; }
declare module 'virtual:den-runtime' { const runtime: string; export default runtime; }
declare module 'virtual:den-examples' {
  const examples: { id: string; module: string; title: string; description: string; file: string; docs: string; source: string }[];
  export default examples;
}
