import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as core from '@unworklet/core';
import * as filters from '@denaudio/den/filter';
import * as envelopes from '@denaudio/den/envelope';
import { renderOffline } from '@unworklet/offline';
import { build } from 'esbuild';
import { captureTypeFiles } from '../type-files.mjs';
import { createTypeProject } from '../src/typescript-project.ts';
import { evaluateSource } from '../src/evaluate-source.ts';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, '..', 'artifacts/playground-proof'); mkdirSync(out, {recursive:true});
const snapshot = captureTypeFiles();
const project = createTypeProject(snapshot);
const filter = readFileSync(join(root, 'test/fixtures/filter.processor.ts'), 'utf8');
const envelope = readFileSync(join(root, 'test/fixtures/envelope.processor.ts'), 'utf8');
const registry = { '@unworklet/core': core, '@denaudio/den/filter': filters, '@denaudio/den/envelope': envelopes };
const manifest = { sourceCommit: execFileSync('git', ['rev-parse','HEAD'], {cwd:join(root,'..'),encoding:'utf8'}).trim(), publicExports: Object.keys(snapshot.packages['@denaudio/den'].exports).length, packageVersions: snapshot.packages, declarationHashes: snapshot.hashes, checks: [], rows: [], browser: 'NOT_RUN' };
try {
  for (const source of [filter, envelope]) { project.sync(source); assert.deepEqual(project.diagnostics(), []); }
  manifest.checks.push('actual packed den/core declarations resolve and typecheck both editable samples');
  const member = filter.replace('low.tick(', 'low.\n/*completion*/tick(');
  project.sync(member); const offset = member.indexOf('low.') + 4;
  const completion = project.service.getCompletionsAtPosition(project.filename, offset, {});
  assert(completion?.entries.some(item => item.name === 'tick'));
  project.sync(filter);
  const hover = project.service.getQuickInfoAtPosition(project.filename, filter.indexOf('filter }'));
  assert(hover && core); const hoverText = hover.displayParts.map(x=>x.text).join(''); assert.match(hoverText, /FilterConfig|SubgraphDecl/);
  const signature = project.service.getSignatureHelpItems(project.filename, filter.indexOf('low.tick(') + 'low.tick('.length, undefined);
  assert(signature && signature.items[0].parameters.length === 4);
  project.sync(filter.replace('cutoff.at(i)', '"bad cutoff"')); const wrongType = project.diagnostics(); assert(wrongType.some(d=>d.code===2345));
  project.sync(filter.replace("'@denaudio/den/filter'", "'@denaudio/den/dist/filter.js'")); assert(project.diagnostics().some(d=>d.code===2307));
  manifest.checks.push('real member completion, hover, four-argument signature, wrong-type diagnostics and private import rejection');
  const bundle = await build({stdin:{contents:"import { makeWorkletNamespaceFromMeta } from '@unworklet/core/worklet'; globalThis.__uwkMakeNs = makeWorkletNamespaceFromMeta;",resolveDir:root},bundle:true,write:false,platform:'browser',format:'iife',target:'es2022',minify:true});
  const runtime = bundle.outputFiles[0].text; manifest.runtimeBytes = runtime.length; manifest.runtimeSHA256 = createHash('sha256').update(runtime).digest('hex');
  for (const [name, source] of [['filter',filter],['envelope',envelope]]) {
    const {processor} = evaluateSource(source, registry);
    const compiled = await core.compile(processor,{sampleRate:48000});
    const meta = core.extractWorkletMeta(compiled.graph);
    const worklet = core.emitWorkletModuleSource(meta,{processorName:'den-proof-'+name,runtime:{kind:'inline',code:runtime}});
    assert(worklet.includes('registerProcessor')); assert(worklet.includes('globalThis.__uwkMakeNs'));
    const input = Float32Array.from({length:32768},(_,i)=>Math.sin(2*Math.PI*220*i/48000)*.12);
    const rendered = await renderOffline(processor,{sampleRate:48000,duration:(32768-.5)/48000,...(name==='filter'?{inputs:{main:[input]}}:{})});
    const values = rendered.outputs.main[0]; const peak = Math.max(...values.map(Math.abs)); const rms = Math.sqrt(values.reduce((a,x)=>a+x*x,0)/values.length);
    assert(values.every(Number.isFinite)); assert(peak > .01 && peak < .35); assert(rms > .005); assert.equal(rendered.diagnostics.scrubbedSamples,0);
    manifest.rows.push({name,peak,rms,frames:values.length,wasmBytes:compiled.wasm.length,workletBytes:worklet.length,sourceSHA256:createHash('sha256').update(source).digest('hex')});
  }
  manifest.checks.push('two actual public-API processors compile to WASM and render finite audible PCM at48kHz with zero scrub; official worklet runtime/emitter bundle');
  assert.throws(()=>evaluateSource("import { processor } from 'not-allowed'; export default processor;",registry),/Unsupported import/);
  console.log(JSON.stringify({checks:manifest.checks,rows:manifest.rows,runtimeBytes:manifest.runtimeBytes,hover: hoverText},null,2));
} catch(error) {manifest.failure=String(error);throw error;}
finally {project.dispose();writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));}
