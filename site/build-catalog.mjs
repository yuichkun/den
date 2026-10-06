import { readFileSync, existsSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { categories, modules, studies } from './catalog-data.mjs';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function validateCatalog(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const classified = new Set(), ids = new Set();
  for (const item of modules) {
    if (ids.has(item.id)) throw Error(`Duplicate catalog id: ${item.id}`); ids.add(item.id);
    if (!categories.some(category => category.id === item.category)) throw Error(`Unknown category: ${item.category}`);
    if (!existsSync(join(root, 'docs', item.docs))) throw Error(`Missing catalog contract: ${item.docs}`);
    for (const name of item.exports) {
      const key = name === '.' ? '.' : `./${name}`;
      if (!pkg.exports[key]) throw Error(`Catalog entry is not exported: ${key}`);
      if (classified.has(key)) throw Error(`Catalog export appears twice: ${key}`);
      classified.add(key);
    }
  }
  const missing = Object.keys(pkg.exports).filter(key => !classified.has(key));
  if (missing.length) throw Error(`Classify new public exports in site/catalog-data.mjs: ${missing.join(', ')}`);
  return { groups: modules.length, exports: classified.size, studies: studies.length };
}
export const siteNav = active => `<a class="site-skip" href="#main-content">本文へ</a><nav class="site-nav" aria-label="メインナビゲーション"><a class="site-brand" href="/" aria-label="den ホーム">den<span class="site-mark" aria-hidden="true">●</span></a><div class="site-links">${[['home','/','カタログ'], ['listening','/catalog.html','A/B 試聴'], ['playground','/playground.html','楽器を弾く']].map(([key, href, label]) => `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</div><span class="site-edition">SOUND TOOLS / 01</span></nav>`;
export function decoratePage(html, active) {
  if (!html.includes('<main>')) throw Error(`Missing main in ${active} page`);
  const css = '<link rel="stylesheet" href="/site.css">';
  html = html.replace('</title>', `</title>${css}`);
  return html.replace('<main>', `${siteNav(active)}<main id="main-content" tabindex="-1">`);
}
const art = (shape, index) => {
  const paths = shape === 'glass' ? [0,1,2,3].map(n => `<ellipse cx="${90 + n * 17}" cy="65" rx="${28+n*4}" ry="45"/>`).join('') : shape === 'hit' ? [0,1,2,3,4].map(n => `<path d="M${70+n*18} 25 V105"/>`).join('') + '<path d="M38 66 Q155 3 246 66 Q155 122 38 66"/>' : shape === 'grain' ? Array.from({length: 18}, (_,n) => `<circle cx="${42+(n%6)*37}" cy="${30+Math.floor(n/6)*34}" r="${[2,6,10,5,3,7][(n*5)%6]}"/>`).join('') : [0,1,2,3].map(n => `<path d="M${30+n*17} 86 Q${68+n*17} ${-12+n*13} ${107+n*17} 65 T${240+n*4} 48"/>`).join('');
  return `<svg class="study-art art-${shape}" viewBox="0 0 300 130" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.3">${paths}</g><text x="268" y="113" fill="currentColor" font-size="10" font-family="monospace">0${index+1}</text></svg>`;
};
export function renderCatalog(root) {
  const counts = validateCatalog(root);
  const docsUrl = file => `https://github.com/yuichkun/den/blob/main/docs/${file}`;
  const cards = modules.map(item => {
    const imports = item.exports.map(name => name === '.' ? '@denaudio/den' : `@denaudio/den/${name}`);
    const search = [item.title, item.description, ...imports, categories.find(c => c.id === item.category).title].join(' ');
    return `<article class="module-card" id="module-${item.id}" data-category="${item.category}" data-playable="${!!item.demo}" data-search="${escape(search)}"><div class="module-meta"><span>${escape(categories.find(c => c.id === item.category).english)}</span><span class="availability${item.demo ? ' has-demo' : ''}">${item.demo ? '試聴例あり' : 'コードで使う'}</span></div><h3>${escape(item.title)}</h3><p>${escape(item.description)}</p><details><summary>使い方・仕様 <span aria-hidden="true">＋</span></summary><div class="module-detail"><p>${escape(item.limit)}</p><span class="detail-label">PUBLIC IMPORT</span>${imports.map(path => `<code>${escape(path)}</code>`).join('')}<a href="${docsUrl(item.docs)}" target="_blank" rel="noopener">仕様を読む <span aria-hidden="true">↗</span><span class="sr-only">（新しいタブ）</span></a>${!item.demo ? '<p class="no-demo">この部品の専用ブラウザ試聴はありません。コードに組み込んで使います。</p>' : ''}</div></details>${item.demo ? `<a class="module-demo" href="${item.demo.href}">${item.demo.label}<span aria-hidden="true">→</span></a>` : ''}</article>`;
  });
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#101915"><meta name="description" content="denの音源・エフェクト・コントロールを探すカタログ。試聴できる音と、コードで使うDSP部品をまとめました。"><title>den · Sound catalog</title><link rel="stylesheet" href="/site.css"><script src="/catalog-home.js" defer></script></head><body class="catalog-page">${siteNav('home')}<main id="main-content" tabindex="-1"><section class="catalog-intro"><div><p class="catalog-kicker">EDITABLE SOUND BUILDING BLOCKS</p><h1>Sound catalog<span class="title-dot">.</span></h1><p class="catalog-lead">音源、エフェクト、コントロール。<br>音の部品を探して、試して、組み合わせる。</p></div><div class="catalog-index"><span>den / unworklet</span><strong>${counts.groups}<small> module groups</small></strong><span>${counts.exports} public imports · 4 sound studies</span></div></section>
<section class="listen-section" aria-labelledby="listen-title"><div class="section-heading"><div><p class="section-number">01 / LISTEN</p><h2 id="listen-title">まずは、音から。</h2></div><p>4つの作例を A/B で比較。<br>再生は操作するまで始まりません。</p></div><div class="study-grid">${studies.map((s,n) => `<a class="study-card" href="/catalog.html?example=${s.id}" aria-label="${escape(s.title)} を A/B 試聴">${art(s.shape,n)}<div class="study-copy"><span class="study-type">${s.type}</span><h3>${s.title}<span aria-hidden="true">↗</span></h3><p>${s.description}</p><span class="study-action">A/B 試聴 <span aria-hidden="true">→</span></span></div></a>`).join('')}</div><a class="instrument-link" href="/playground.html?instrument=bass"><span><b>鍵盤で弾きたい？</b> Bass・Percussion・Pad に、Chorus・Delay を組み合わせる。</span><span>楽器を弾く →</span></a></section>
<section class="browse-section" aria-labelledby="browse-title"><div class="section-heading"><div><p class="section-number">02 / EXPLORE</p><h2 id="browse-title">部品を探す</h2></div><p>実装済みの公開部品を用途別に。<br>「試聴例あり」以外はコードから使います。</p></div><div class="catalog-tools" id="catalog-tools" hidden><label class="search-label" for="catalog-search"><span>キーワードで検索</span><div class="search-wrap"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="m12 12 5 5"/></svg><input type="search" id="catalog-search" placeholder="例：delay、波形、グラニュラー" autocomplete="off" aria-controls="module-list"></div></label><label class="demo-filter"><input type="checkbox" id="demo-filter"> 試聴例あり</label></div><div class="category-filters" id="category-filters" role="group" aria-label="用途で絞り込む" hidden><button data-filter="all" aria-pressed="true">すべて <span>${counts.groups}</span></button>${categories.map(c => `<button data-filter="${c.id}" aria-pressed="false"><span class="category-dot ${c.id}"></span>${c.title}<span>${modules.filter(m=>m.category===c.id).length}</span></button>`).join('')}</div><div class="results-line"><p id="result-count" role="status" aria-live="polite">${counts.groups} 件のモジュールグループ</p><button id="clear-filters" hidden>絞り込みを解除</button></div><div id="empty-results" class="empty-results" hidden><h3>一致する部品はありません</h3><p>別のキーワードを試すか、絞り込みを解除してください。</p></div><div id="module-list">${categories.map(c => `<section class="module-group" data-group="${c.id}" aria-labelledby="heading-${c.id}"><div class="group-heading"><h2 id="heading-${c.id}"><span class="category-dot ${c.id}"></span>${c.title} <span>${c.english}</span></h2><p>${c.description}</p></div><div class="module-grid">${cards.filter((_,n)=>modules[n].category===c.id).join('')}</div></section>`).join('')}</div></section>
<aside class="catalog-boundary" aria-labelledby="boundary-title"><span class="candidate-tag">CANDIDATE</span><div><h2 id="boundary-title">試している音。承認済みの音ではありません。</h2><p>音量を下げてから再生してください。ブラウザ試聴は48 kHz。テスト合格は、人による音の承認や、すべての機器での実時間動作を保証しません。</p><a href="${docsUrl('initial-acceptance.md')}" target="_blank" rel="noopener">検証範囲と制約を読む ↗<span class="sr-only">（新しいタブ）</span></a></div></aside></main><footer class="site-footer"><span class="footer-brand">den.</span><p>Small parts. Many sounds.</p><a href="https://github.com/yuichkun/den" target="_blank" rel="noopener">Source & documentation ↗<span class="sr-only">（新しいタブ）</span></a></footer></body></html>`;
}
export function writeCatalog(root, output) {
  writeFileSync(join(output, 'index.html'), renderCatalog(root));
  for (const file of ['site.css', 'catalog-home.js']) cpSync(join(root, 'site', file), join(output, file));
}
