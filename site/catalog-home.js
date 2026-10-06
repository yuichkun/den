// Progressive enhancement: the complete catalog and links also work without JS.
const search = document.getElementById('catalog-search');
const demos = document.getElementById('demo-filter');
const buttons = [...document.querySelectorAll('[data-filter]')];
const cards = [...document.querySelectorAll('.module-card')];
const groups = [...document.querySelectorAll('[data-group]')];
const reset = document.getElementById('clear-filters');
let category = 'all';
const normalize = value => value.normalize('NFKC').toLocaleLowerCase().trim();
function fromUrl() {
  const query = new URLSearchParams(location.search);
  search.value = query.get('q') || '';
  category = buttons.some(button => button.dataset.filter === query.get('category')) ? query.get('category') : 'all';
  demos.checked = query.get('demo') === '1';
}
function render() {
  const words = normalize(search.value).split(/\s+/).filter(Boolean);
  let visible = 0;
  for (const card of cards) {
    const matches = (category === 'all' || card.dataset.category === category) && (!demos.checked || card.dataset.playable === 'true') && words.every(word => normalize(card.dataset.search).includes(word));
    card.hidden = !matches;
    if (matches) visible++;
  }
  for (const group of groups) group.hidden = !group.querySelector('.module-card:not([hidden])');
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.filter === category));
  document.getElementById('result-count').textContent = `${visible} / ${cards.length} 件のモジュールグループ`;
  document.getElementById('empty-results').hidden = visible !== 0;
  reset.hidden = !search.value && category === 'all' && !demos.checked;
}
function update(mode) {
  render();
  const url = new URL(location.href);
  for (const [key, value] of [['q', search.value.trim()], ['category', category === 'all' ? '' : category], ['demo', demos.checked ? '1' : '']]) value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
  // Filtering never changes an audio page or creates an AudioContext.
  if (url.href !== location.href) history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', url);
}
search.addEventListener('input', () => update('replace'));
search.addEventListener('keydown', event => { if (event.key === 'Escape') { search.value = ''; update('replace'); } });
demos.addEventListener('change', () => update('push'));
for (const button of buttons) button.addEventListener('click', () => { category = button.dataset.filter; update('push'); });
reset.addEventListener('click', () => { search.value = ''; category = 'all'; demos.checked = false; update('push'); search.focus(); });
window.addEventListener('popstate', () => { fromUrl(); render(); });
fromUrl(); render();
document.getElementById('catalog-tools').hidden = false;
document.getElementById('category-filters').hidden = false;
