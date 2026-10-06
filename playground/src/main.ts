import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import examples from 'virtual:den-examples';
import { attachEditorAssistance, setDiagnostics } from './editor/monaco-assistance.ts';
import type { EditorDiagnostic } from './editor/protocol.ts';
import { AudioSession } from './audio-session.ts';
import './style.css';
(globalThis as typeof globalThis & { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<header class="topbar"><a class="brand" href="/">den <span>playground</span></a><div class="toplinks"><a href="https://github.com/yuichkun/den" target="_blank" rel="noreferrer">Source ↗</a><span>unworklet 0.4.1</span></div></header>
<main class="workspace">
<aside class="library" aria-label="Modules"><div class="library-heading"><h1>Modules <small>${examples.length}</small></h1><button id="close-library" class="mobile-only" aria-label="Close module list">×</button></div><label class="search"><span class="sr-only">Find a module</span><input id="search" type="search" placeholder="Find a module…" autocomplete="off" spellcheck="false"></label><nav id="modules" aria-label="Module examples"></nav><p id="no-results" hidden>No matching modules.</p><footer>Editable TypeScript<br>48 kHz · Web Audio</footer></aside>
<section class="editor-pane" aria-label="Processor source"><div class="filebar"><button id="open-library" class="mobile-only">Modules</button><div><strong id="filename"></strong><span id="modified" hidden>Modified</span></div><a id="docs" target="_blank" rel="noreferrer">Docs ↗</a></div><div class="sample-summary"><code id="import-path"></code><p id="description"></p></div><div class="runbar"><div class="run-actions"><button id="run" class="primary">Run <kbd>⌘ ↵</kbd></button><button id="stop" disabled>Stop</button><button id="reset">Reset</button></div><span id="audio-status" role="status" aria-live="polite">Audio is stopped.</span></div><div id="editor"></div><div class="editor-status"><span id="type-status" role="status">Loading TypeScript…</span><span>TypeScript <span aria-hidden="true">·</span> <span id="cursor">Ln 1, Col 1</span></span></div><div id="issues" hidden aria-label="Source errors"></div><pre id="run-error" role="alert" hidden></pre></section>
<aside class="controls" aria-label="Audio controls"><section><h2>Output</h2><label class="range-label" for="volume">Level <output id="volume-value">25%</output></label><input id="volume" aria-label="Output level" type="range" min="0" max="1" step="0.01" value="0.25"><div class="meter" role="meter" aria-label="Output signal" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"><i></i></div><p class="hint">Start quietly. Changes to code apply on Run.</p></section><section id="input-section" hidden><h2>Input source</h2><p id="input-names" class="hint"></p><label for="input-type">Waveform</label><select id="input-type"><option value="sawtooth">Saw</option><option value="sine">Sine</option><option value="square">Square</option><option value="triangle">Triangle</option><option value="noise">Noise</option></select><label class="range-label" for="input-frequency">Frequency <output id="frequency-value">110 Hz</output></label><input id="input-frequency" type="range" min="20" max="2000" step="1" value="110"><label class="range-label" for="input-level">Level <output id="input-level-value">0.10</output></label><input id="input-level" type="range" min="0" max="0.25" step="0.005" value="0.1"><label class="check"><input id="pulsed" type="checkbox"> Pulsed input</label></section><section><h2>AudioParams</h2><div id="parameters"><p class="hint">Run the example to expose its native parameters.</p></div></section><details class="host"><summary>Host setup</summary><p class="hint">The processor uses normal den + unworklet TypeScript. This host compiles it in a cancellable worker, then uses the public node API.</p><p class="hint">Optional exports <code>initial</code>, <code>events</code>, <code>midi</code>, <code>ready</code> and <code>afterReady</code> are playground setup data, not den APIs. The excerpt below shows their native calls after Run; see the complete host implementation in the contract.</p><pre id="host-code">await createNode(context, compiledProcessor);
// Run to inspect this example's native setup.</pre><a href="https://github.com/yuichkun/den/blob/main/playground/README.md" target="_blank" rel="noreferrer">Sample contract ↗</a></details></aside>
</main>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const drafts = new Map<string, string>();
let selected = examples.find(item => item.id === new URL(location.href).searchParams.get('module')) ?? examples.find(item => item.id === 'oscillator')!;
let changing = false, currentDiagnostics: EditorDiagnostic[] = [];
const model = monaco.editor.createModel(selected.source, 'typescript', monaco.Uri.parse('file:///project/example.processor.ts'));
monaco.editor.defineTheme('den-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#ffffff', 'editorLineNumber.foreground': '#9aa1ad', 'editorLineNumber.activeForeground': '#334155', 'editor.lineHighlightBackground': '#f6f8fb', 'editor.selectionBackground': '#dce7ff', 'editorIndentGuide.background1': '#edf0f5' } });
const editor = monaco.editor.create($('editor'), { model, theme: 'den-light', automaticLayout: true, fontSize: 13, lineHeight: 21, fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', minimap: { enabled: false }, scrollBeyondLastLine: false, renderLineHighlight: 'line', padding: { top: 16, bottom: 16 }, tabSize: 2, wordWrap: 'off', fontLigatures: false, ariaLabel: 'Editable processor TypeScript', fixedOverflowWidgets: true, suggest: { showWords: false }, quickSuggestions: { other: true, comments: false, strings: false } });
const session = new AudioSession(renderAudio, (diagnostics, version) => {
  if (version !== model.getVersionId()) return;
  const values: EditorDiagnostic[] = diagnostics.map(item => ({ ...item, code: `TS${item.code}`, phase: 'compile' }));
  setDiagnostics(model, 'den-compile', values); renderIssues(values);
});
const assist = () => attachEditorAssistance(model, (diagnostics, status) => { currentDiagnostics = diagnostics; $('type-status').textContent = status; renderIssues(diagnostics); });
let assistance = assist();
function renderIssues(diagnostics: EditorDiagnostic[]) {
  const list = $('issues'); list.replaceChildren(); list.hidden = !diagnostics.length;
  for (const item of diagnostics.slice(0, 6)) {
    const button = document.createElement('button'); button.className = 'issue';
    const position = model.getPositionAt(item.start ?? 0);
    button.textContent = `Ln ${position.lineNumber} · ${item.message}`;
    button.onclick = () => { editor.setPosition(position); editor.revealPositionInCenter(position); editor.focus(); };
    list.append(button);
  }
}
function renderList() {
  const query = $('search') as HTMLInputElement;
  const needle = query.value.normalize('NFKC').toLowerCase();
  const results = examples.filter(item => `${item.id} ${item.title} ${item.description} ${item.module}`.normalize('NFKC').toLowerCase().includes(needle));
  const list = $('modules'); list.replaceChildren();
  for (const item of results) {
    const link = document.createElement('a'); link.href = `?module=${encodeURIComponent(item.id)}`; link.textContent = item.id;
    link.title = item.description; if (item === selected) link.setAttribute('aria-current', 'page');
    link.onclick = event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); select(item.id, true); };
    list.append(link);
  }
  $('no-results').hidden = results.length > 0;
}
function renderSelection() {
  $('filename').textContent = selected.file;
  $('import-path').textContent = selected.module === '.' ? '@denaudio/den' : `@denaudio/den/${selected.module.slice(2)}`;
  $('description').textContent = selected.description;
  ($('docs') as HTMLAnchorElement).href = `https://github.com/yuichkun/den/blob/main/docs/${selected.docs}`;
  $('modified').hidden = model.getValue() === selected.source;
  renderList();
}
function select(id: string, historyEntry = false) {
  const next = examples.find(item => item.id === id); if (!next) return;
  void session.stop(); session.clearError(); drafts.set(selected.id, model.getValue()); selected = next;
  changing = true; model.setValue(drafts.get(next.id) ?? next.source); changing = false;
  setDiagnostics(model, 'den-compile', []); editor.setScrollTop(0); editor.setPosition({ lineNumber: 1, column: 1 });
  if (historyEntry) { const url = new URL(location.href); url.searchParams.set('module', id); history.pushState({}, '', url); }
  document.body.classList.remove('show-library');
  $('host-code').textContent = '// Run this example to inspect its native host setup.';
  renderSelection();
}
let parameterKey = '';
function renderAudio() {
  $('audio-status').textContent = session.message; $('audio-status').dataset.phase = session.phase;
  ($('run') as HTMLButtonElement).disabled = ['compiling', 'preparing', 'stopping'].includes(session.phase);
  ($('stop') as HTMLButtonElement).disabled = ['idle', 'error'].includes(session.phase);
  $('run-error').hidden = !session.error; $('run-error').textContent = session.error;
  $('input-section').hidden = !session.inputNames.length;
  $('input-names').textContent = `Connected to ${session.inputNames.join(', ')}.`;
  $('volume-value').textContent = `${Math.round(session.volume * 100)}%`;
  $('frequency-value').textContent = `${session.inputFrequency} Hz`; $('input-level-value').textContent = session.inputLevel.toFixed(2);
  const key = `${session.created}/${session.parameters.map(item => item.name).join('/')}`;
  if (key !== parameterKey) {
    parameterKey = key; const container = $('parameters'); container.replaceChildren();
    if (!session.parameters.length) { const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = session.phase === 'playing' ? 'This example has no AudioParams.' : 'Run the example to expose its native parameters.'; container.append(hint); }
    for (const item of session.parameters) {
      const label = document.createElement('label'); label.className = 'parameter';
      const text = document.createElement('span'); text.textContent = item.name;
      const input = document.createElement('input'); input.type = 'number'; input.min = String(item.min); input.max = String(item.max); input.step = 'any'; input.value = String(item.value); input.setAttribute('aria-label', item.name);
      input.oninput = () => { if (input.value !== '' && input.validity.valid) session.setParameter(item.name, input.valueAsNumber); };
      label.append(text, input); container.append(label);
    }
  }
  if (session.setup && session.phase === 'playing') {
    const setup = session.setup;
    $('host-code').textContent = [
      "// Compiled with the public unworklet compile/emitter APIs.",
      "const node = await createNode(context, compiledProcessor, {", `  initial: ${JSON.stringify(setup.initial)},`, "});",
      "node.outputs.main.connect(master);", "master.connect(context.destination);",
      ...session.inputNames.map(name => `source.connect(node.inputs[${JSON.stringify(name)}]);`),
      ...setup.events.map(item => `node.events[${JSON.stringify(item.name)}].emit(events.find(e => e.name === ${JSON.stringify(item.name)})!.payload);`),
      ...(setup.ready.length ? ['// Poll inspect(await node.snapshot()).slots with a 5 s timeout.', ...setup.ready.map(item => `// Wait for state ending ${JSON.stringify(item.suffix)} === ${JSON.stringify(item.value)}.`)] : []),
      ...Object.entries(setup.afterReady).map(([name, value]) => `node.params[${JSON.stringify(name)}].setValueAtTime(${value}, context.currentTime);`),
      ...setup.midi.map(item => `node.midi[${JSON.stringify(item.port)}].send(${JSON.stringify(item.event)});`),
      '// On Stop: fade output, node.dispose(), context.close().',
    ].join('\n');
  }
}
function run() { setDiagnostics(model, 'den-compile', []); void session.run(model.getValue(), model.getVersionId()); }
$('run').onclick = run; $('stop').onclick = () => void session.stop();
$('reset').onclick = () => { void session.stop(); model.setValue(selected.source); session.clearError(); };
$('search').oninput = renderList;
$('open-library').onclick = () => { document.body.classList.add('show-library'); $('search').focus(); };
$('close-library').onclick = () => document.body.classList.remove('show-library');
$('volume').oninput = event => session.setVolume((event.target as HTMLInputElement).valueAsNumber);
$('input-type').onchange = event => session.setInput({ type: (event.target as HTMLSelectElement).value as OscillatorType | 'noise' });
$('input-frequency').oninput = event => session.setInput({ frequency: (event.target as HTMLInputElement).valueAsNumber });
$('input-level').oninput = event => session.setInput({ level: (event.target as HTMLInputElement).valueAsNumber });
$('pulsed').onchange = event => session.setInput({ pulsed: (event.target as HTMLInputElement).checked });
model.onDidChangeContent(() => { if (changing) return; drafts.set(selected.id, model.getValue()); $('modified').hidden = model.getValue() === selected.source; setDiagnostics(model, 'den-compile', []); if (['compiling', 'preparing'].includes(session.phase)) void session.stop('Source changed. Run again to compile.'); session.clearError(); });
editor.onDidChangeCursorPosition(event => { $('cursor').textContent = `Ln ${event.position.lineNumber}, Col ${event.position.column}`; });
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);
window.addEventListener('keydown', event => { if (event.key === 'Escape') { document.body.classList.remove('show-library'); if (['compiling', 'preparing'].includes(session.phase)) void session.stop(); } });
window.addEventListener('popstate', () => select(new URL(location.href).searchParams.get('module') ?? 'oscillator'));
window.addEventListener('pagehide', () => { assistance.dispose(); void session.stop('Audio is stopped.', true); });
window.addEventListener('pageshow', event => { if (event.persisted) assistance = assist(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) void session.stop('Stopped while the page was hidden.', true); });
const meter = document.querySelector<HTMLElement>('.meter')!, bar = meter.querySelector<HTMLElement>('i')!;
setInterval(() => { const signal = session.samples(), peak = Math.max(...signal.map(Math.abs)); bar.style.width = `${Math.min(1, peak) * 100}%`; meter.setAttribute('aria-valuenow', String(peak)); }, 100);
renderSelection(); renderAudio();
// Read-only observations used by the browser gate; edits and Run use the real UI.
Object.defineProperty(window, '__denPlayground', { value: { state: () => ({ ...session.measure(), example: selected.id, source: model.getValue(), diagnostics: currentDiagnostics, markers: monaco.editor.getModelMarkers({ resource: model.uri }) }), editor, model }, configurable: false });
