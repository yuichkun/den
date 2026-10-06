import ts from 'typescript';
import { createTypeProject, type TypeFiles } from '../typescript-project.ts';
import type { EditorQuery, EditorResult } from './protocol.ts';
const display = (parts: ts.SymbolDisplayPart[] | undefined) => ts.displayPartsToString(parts);
export function createEditorService(snapshot: TypeFiles) {
  const project = createTypeProject(snapshot), ls = project.service, file = project.filename;
  return {
    query(query: EditorQuery): EditorResult {
      project.sync(query.source);
      const result: EditorResult = { uri: query.uri, version: query.version };
      if (query.kind === 'diagnostics') result.diagnostics = project.diagnostics().map(d => ({ ...d, phase: 'type', code: `TS${d.code}` }));
      if (query.kind === 'hover') {
        const info = ls.getQuickInfoAtPosition(file, query.offset);
        if (info) result.hover = { text: display(info.displayParts), documentation: display(info.documentation), ...info.textSpan };
      }
      if (query.kind === 'completion') {
        const info = ls.getCompletionsAtPosition(file, query.offset, { includeCompletionsForModuleExports: false, includeCompletionsWithInsertText: true });
        const prefix = query.source.slice(0, query.offset).match(/[\w$]*$/)?.[0] ?? '';
        result.completions = (info?.entries ?? []).filter(entry => !entry.source).map(entry => ({ name: entry.name, insertText: entry.insertText ?? entry.name, kind: entry.kind, sortText: entry.sortText, ...(entry.replacementSpan ?? info?.optionalReplacementSpan ?? { start: query.offset - prefix.length, length: prefix.length }) }));
      }
      if (query.kind === 'signature') {
        const info = ls.getSignatureHelpItems(file, query.offset, undefined);
        if (info) result.signature = {
          activeSignature: info.selectedItemIndex, activeParameter: info.argumentIndex,
          items: info.items.map(item => {
            let label = display(item.prefixDisplayParts);
            const parameters = item.parameters.map((parameter, index) => {
              if (index) label += display(item.separatorDisplayParts);
              const start = label.length; label += display(parameter.displayParts);
              return { label: [start, label.length] as [number, number], documentation: display(parameter.documentation) };
            });
            label += display(item.suffixDisplayParts);
            return { label, parameters, documentation: display(item.documentation) };
          }),
        };
      }
      return result;
    },
    dispose: project.dispose,
  };
}
