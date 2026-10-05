import assert from 'node:assert/strict';

// Used by the packed-site test. These probes observe native Web Audio objects;
// they never replace a processor, generate audio, or relax browser autoplay.
export async function runCatalogLifecycle(browser, url) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const probe = window.__catalogProbe = { contexts: [], worklets: [], resumeWaiters: [], snapshotWaiters: [], holdResume: false, holdSnapshot: false, failContext: false, disconnects: 0, portCloses: 0 };
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(...args) {
        if (probe.failContext) throw new DOMException('Test context unavailable', 'NotSupportedError');
        super(...args); probe.contexts.push(this);
      }
      resume() {
        if (!probe.holdResume) return super.resume();
        return new Promise((resolve, reject) => probe.resumeWaiters.push(() => super.resume().then(resolve, reject)));
      }
      close() {
        sessionStorage.setItem('catalogNativeCloseCalls', String(Number(sessionStorage.getItem('catalogNativeCloseCalls') || 0) + 1));
        return super.close();
      }
    };
    const NativeWorklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeWorklet {
      constructor(...args) {
        super(...args); probe.worklets.push(this);
        const post = this.port.postMessage.bind(this.port), close = this.port.close.bind(this.port);
        this.port.postMessage = (message, ...rest) => {
          if (probe.holdSnapshot && message?.kind === 'snapshot-request') probe.snapshotWaiters.push(() => post(message, ...rest));
          else post(message, ...rest);
        };
        this.port.close = () => { probe.portCloses++; return close(); };
      }
      disconnect(...args) { probe.disconnects++; return super.disconnect(...args); }
    };
  });
  const state = () => page.evaluate(() => window.denCatalog.state());
  const load = async () => { await page.goto(url); await page.waitForFunction(() => !!window.denCatalog); };
  const ready = () => page.waitForFunction(() => window.denCatalog.state().ready, null, { timeout: 30000 });
  const idle = () => page.waitForFunction(() => window.denCatalog.state().phase === 'idle');
  const settled = () => page.waitForFunction(() => window.denCatalog.state().settled === window.denCatalog.state().started);
  const nativeClosed = () => page.evaluate(() => window.__catalogProbe.contexts.every(ctx => ctx.state === 'closed'));
  const start = async key => { if (key) await page.click(`[data-example="${key}"]`); await page.click('#start'); await ready(); };
  const stop = async () => { await page.click('#stop'); await idle(); await settled(); assert(await nativeClosed(), 'all actual AudioContexts must close'); };
  const audioAdvance = seconds => page.evaluate(seconds => new Promise((resolve, reject) => {
    const ctx = window.__catalogProbe.contexts.at(-1), until = ctx.currentTime + seconds, deadline = performance.now() + 10000;
    const tick = () => ctx.currentTime >= until ? resolve() : performance.now() > deadline ? reject(new Error('Native audio clock did not advance')) : setTimeout(tick, 10);
    tick();
  }), seconds);
  try {
    await load();
    assert.equal(await page.evaluate(() => window.__catalogProbe.contexts.length), 0, 'page load must not construct an AudioContext');
    assert.equal(await page.evaluate(() => window.__catalogProbe.worklets.length), 0);
    assert.equal(await page.locator('#volume').inputValue(), '1');
    assert.match(await page.locator('.notice').innerText(), /low device volume/i);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    checks.push('independent native probes confirm no context/worklet/autoplay; unity master and mobile width');

    // Constructor failure must preserve retry, no held intent and no context.
    await page.evaluate(() => { window.__catalogProbe.failContext = true; });
    await page.click('#start');
    assert.match(await page.locator('#status').innerText(), /Test context unavailable/);
    assert.equal((await state()).phase, 'idle'); assert.deepEqual((await state()).held, []);
    assert.equal(await page.evaluate(() => window.__catalogProbe.contexts.length), 0);
    await page.evaluate(() => { window.__catalogProbe.failContext = false; window.__catalogProbe.holdResume = true; });
    await page.click('#start');
    await page.waitForFunction(() => window.__catalogProbe.resumeWaiters.length === 1);
    await page.locator('#start').dispatchEvent('click');
    assert.equal((await state()).started, 1, 'repeated Start during resume must not create another session');
    await page.click('#stop'); await idle(); assert(await nativeClosed());
    await page.evaluate(() => { const p = window.__catalogProbe; p.holdResume = false; p.resumeWaiters.splice(0).forEach(resolve => resolve()); });
    await settled(); assert.equal((await state()).phase, 'idle'); assert.equal((await state()).lastError, null);
    checks.push('constructor error recovers; delayed native resume cancels; repeated Start cannot multiply sessions');

    // Stop after real createNode has started fetching the compiled WASM, then
    // start a different material before the earlier request completes.
    await load();
    let unblock, requested, blocked = false;
    const barrier = new Promise(resolve => { unblock = resolve; });
    const request = new Promise(resolve => { requested = resolve; });
    const routeHandler = async route => {
      if (!blocked) { blocked = true; requested(); await barrier; }
      await route.continue();
    };
    await page.route('**/*.wasm', routeHandler);
    try {
      await page.click('[data-example="hit"]'); await page.click('#start');
      let timer;
      try { await Promise.race([request, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No native WASM request reached the cancellation barrier')), 20000); })]); }
      finally { clearTimeout(timer); }
      assert.equal((await state()).phase, 'loading');
      await page.click('#stop'); await idle(); assert(await nativeClosed());
      await start('glass');
      await page.locator('#volume').evaluate(el => { el.value = '0.37'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      unblock(); await settled();
      const s = await state(); assert.equal(s.selected, 'glass'); assert.equal(s.phase, 'ready'); assert.equal(s.lastError, null);
      assert.equal(s.nativeParams.gateA, 0); assert.equal(s.nativeParams.gateB, 0);
      assert.equal(await page.evaluate(() => window.__catalogProbe.contexts[0].state), 'closed');
      const gain = await page.evaluate(() => window.denCatalog.measure(.2)); assert(Math.abs(gain.volume - .37) < 1e-5);
      await stop();
    } finally { unblock(); await page.unroute('**/*.wasm', routeHandler); }
    checks.push('late WASM completion cannot revive a stopped session or overwrite the current material/master');

    // A genuine loader rejection closes the context and remains retryable.
    await load();
    const failWasm = route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Intentional test-only WASM failure' });
    await page.route('**/*.wasm', failWasm);
    try {
      await page.click('[data-example="hit"]'); await page.click('#start'); await idle(); await settled();
      assert.match((await state()).lastError, /503/); assert(await nativeClosed());
      assert.equal(await page.evaluate(() => window.__catalogProbe.worklets.length), 0);
    } finally { await page.unroute('**/*.wasm', failWasm); }
    await start('hit'); assert.equal((await state()).lastError, null);
    await page.locator('[data-trigger="strike"]').focus(); await page.keyboard.down('Enter');
    const firstHit = await page.evaluate(() => window.denCatalog.measure(.06));
    assert(firstHit.raw.every(x => x.finite && x.peak > 1e-4 && x.peak < .35));
    await page.keyboard.up('Enter');
    const hitTail = await page.evaluate(() => window.denCatalog.measure(.9));
    assert(hitTail.raw.every(x => x.peak < 1e-4));
    await page.keyboard.down('Enter');
    const nextHit = await page.evaluate(() => window.denCatalog.measure(.06));
    assert(nextHit.raw.every(x => x.finite && x.peak > 1e-4 && x.peak < .35), 'a released hit must audibly retrigger without restarting the context');
    await page.keyboard.up('Enter'); await stop();
    checks.push('actual WASM HTTP failure closes and retries; native hit output decays and retriggers in the same context');

    // Hold the actual native snapshot request, not a wall-clock guess about
    // loading. Gates and triggers must stay off until native receipt is proven.
    await load(); await page.evaluate(() => { window.__catalogProbe.holdSnapshot = true; });
    await page.click('#start');
    await page.waitForFunction(() => window.__catalogProbe.snapshotWaiters.length > 0);
    assert.equal((await state()).phase, 'loading'); assert.equal((await state()).lastAsset, null);
    assert.equal((await state()).nativeParams.gateA, 0); assert.equal((await state()).nativeParams.gateB, 0);
    await page.locator('[data-trigger="voice-a"]').dispatchEvent('pointerdown', { pointerId: 901 });
    await page.locator('[data-trigger="voice-a"]').dispatchEvent('click');
    await page.locator('[data-example="grain"]').dispatchEvent('click');
    assert.deepEqual((await state()).held, []); assert.equal((await state()).selected, 'glass');
    await stop();
    assert.equal(await page.evaluate(() => window.__catalogProbe.portCloses), 1, 'preload cancellation must dispose the node port');
    await page.evaluate(() => { const p = window.__catalogProbe; p.holdSnapshot = false; p.snapshotWaiters.splice(0).forEach(send => send()); });
    assert.equal((await state()).phase, 'idle'); assert.equal((await state()).lastAsset, null);
    checks.push('native asset acknowledgement barrier keeps gates silent and supports Stop/disposal during preload');

    for (const key of ['echo', 'grain', 'hit', 'glass']) await page.click(`[data-example="${key}"]`);
    assert.equal((await state()).selected, 'glass');
    await start('glass');
    const n = (await state()).started;
    await page.locator('#start').dispatchEvent('click'); assert.equal((await state()).started, n);
    // Unrelated focused native buttons keep normal keyboard activation.
    await page.locator('[data-trigger="voice-a"]').focus(); await page.keyboard.down('Enter');
    assert.deepEqual((await state()).held, ['gateA']); await page.keyboard.up('Enter'); assert.deepEqual((await state()).held, []);
    await page.locator('[data-trigger="voice-b"]').focus(); await page.keyboard.down('Space');
    assert.deepEqual((await state()).held, ['gateB']); await page.keyboard.up('Space'); assert.deepEqual((await state()).held, []);
    // Screen-reader/virtual clicks need a bounded, audible trigger too.
    const virtualHeld = await page.locator('[data-trigger="voice-a"]').evaluate(el => { el.click(); return window.denCatalog.state().held; });
    assert(virtualHeld.includes('gateA'));
    await page.waitForFunction(() => window.denCatalog.state().held.length === 0, null, { timeout: 2000 });
    await page.locator('#volume').focus(); await page.keyboard.press('Space'); assert.deepEqual((await state()).held, []);
    await page.locator('#stop').focus(); await page.keyboard.press('Space'); await idle(); await settled(); assert(await nativeClosed());
    checks.push('Enter/Space activate focused triggers; virtual clicks release; focused slider and Stop retain native keys');

    // Real touch pointers exercise capture and independent release, rather than
    // treating desktop mouse events as proof of mobile multitouch.
    await start('glass');
    const a = page.locator('[data-trigger="voice-a"]'), b = page.locator('[data-trigger="voice-b"]');
    await a.scrollIntoViewIfNeeded(); const ab = await a.boundingBox(), bb = await b.boundingBox();
    const fingers = [{ x: ab.x + ab.width / 2, y: ab.y + ab.height / 2, id: 11 }, { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 12 }];
    const client = await context.newCDPSession(page);
    await page.evaluate(() => {
      const controller = new AbortController();
      const probe = window.__catalogTouchProbe = { events: [], stop: () => controller.abort() };
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) {
        document.addEventListener(type, event => {
          if (event.pointerType !== 'touch') return;
          probe.events.push({ type: event.type, pointerId: event.pointerId,
            trigger: event.target.closest?.('[data-trigger]')?.dataset.trigger ?? null,
            trusted: event.isTrusted });
        }, { capture: true, signal: controller.signal });
      }
    });
    const touchEvents = () => page.evaluate(() => window.__catalogTouchProbe.events);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers });
    const downs = (await touchEvents()).filter(event => event.type === 'pointerdown');
    assert.equal(downs.length, 2, 'both CDP contacts must produce native pointerdown events');
    assert.deepEqual(downs.map(event => event.trigger).sort(), ['voice-a', 'voice-b']);
    assert(downs.every(event => event.trusted), 'touch evidence must come from trusted browser input');
    const pointerA = downs.find(event => event.trigger === 'voice-a').pointerId;
    const pointerB = downs.find(event => event.trigger === 'voice-b').pointerId;
    assert.notEqual(pointerA, pointerB, 'the browser must assign independent pointer identities');
    assert.deepEqual([...(await state()).held].sort(), ['gateA', 'gateB']);
    // Chromium CreateWebTouchEvents releases the supplied IDs on nonempty
    // touchEnd; it does not interpret touchPoints as the contacts left down.
    // DOM pointer IDs may be remapped, so observe their target/identity above.
    // https://github.com/chromium/chromium/blob/148.0.7778.96/content/browser/devtools/protocol/input_handler.cc
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [fingers[0]] });
    assert.deepEqual((await touchEvents()).filter(event => ['pointerup', 'pointercancel'].includes(event.type)),
      [{ type: 'pointerup', pointerId: pointerA, trigger: 'voice-a', trusted: true }],
      'ending contact A must release its native pointer while B remains down');
    assert.deepEqual((await state()).held, ['gateB']);
    await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    const observedTouchEvents = await touchEvents();
    assert.deepEqual(observedTouchEvents.filter(event => ['pointerup', 'pointercancel'].includes(event.type)),
      [{ type: 'pointerup', pointerId: pointerA, trigger: 'voice-a', trusted: true },
        { type: 'pointercancel', pointerId: pointerB, trigger: 'voice-b', trusted: true }],
      'cancel must target only the remaining B pointer');
    assert.deepEqual((await state()).held, []);
    checks.push({ check: 'trusted native touch target/identity sequence', events: observedTouchEvents });
    await page.evaluate(() => window.__catalogTouchProbe.stop());
    await audioAdvance(.4);
    assert((await page.evaluate(() => window.denCatalog.measure(.1))).raw.every(x => x.peak === 0), 'touch cancellation must release the actual sound');
    await client.detach();
    await page.evaluate(() => { document.getElementById('clear').click(); document.getElementById('stop').click(); });
    await idle(); await settled(); assert(await nativeClosed());
    await start('glass'); assert.equal((await state()).nativeParams.reset, 0);
    // A processor failure must dispose and close, then a fresh Start must work.
    await page.evaluate(() => window.__catalogProbe.worklets.at(-1).dispatchEvent(new Event('processorerror')));
    await idle(); await settled(); assert(await nativeClosed()); assert((await state()).lastError);
    const disposal = await page.evaluate(() => ({ ports: window.__catalogProbe.portCloses, nodes: window.__catalogProbe.worklets.length, disconnects: window.__catalogProbe.disconnects }));
    assert.equal(disposal.ports, disposal.nodes); assert(disposal.disconnects >= disposal.nodes);
    await start('grain'); assert.equal((await state()).lastError, null); await stop();
    checks.push('rapid stopped material choices; two touch fingers release independently; touchCancel reaches silence; Stop interrupts Clear; fatal native processor error cleans up and retries');

    // Hiding the document is an immediate close, not merely a note release.
    await start('hit');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden; });
    await idle(); await settled(); assert(await nativeClosed());
    // Actual navigation checks synchronous close invocation via sessionStorage
    // because the old document is no longer inspectable after it unloads.
    await start('echo');
    const closes = await page.evaluate(() => Number(sessionStorage.getItem('catalogNativeCloseCalls') || 0));
    await page.getByRole('link', { name: 'Initial sound / FX candidate', exact: true }).click();
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('catalogNativeCloseCalls') || 0)), closes + 1, 'navigation must close the native context');
    await page.goBack(); await page.waitForFunction(() => !!window.denCatalog);
    assert.equal((await state()).phase, 'idle'); assert(await nativeClosed());
    await page.goForward(); assert.equal(new URL(page.url()).pathname, '/');
    checks.push('visibility, actual route navigation and browser Back/Forward leave audio off');
    assert.deepEqual(errors, [], 'no unhandled browser errors in interrupted lifecycle flows');
    return checks;
  } finally { await context.close(); }
}
