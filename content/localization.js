/* Local dictionaries only: no visitor text, holdings inputs or credentials leave the browser. */
(async () => {
  const languages = { en: 'English', zh: '中文', hi: 'हिन्दी', es: 'Español', ar: 'العربية' };
  const supported = code => Object.hasOwn(languages, code);
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  function template(text) {
    const values = [];
    const key = normalize(text).replace(/\d+(?:[.,:/-]\d+)*(?:%|[KMB])?/g, value => { values.push(value); return `{{${values.length - 1}}}`; });
    return { key, values };
  }
  const source = new WeakMap(), rendered = new WeakMap(), attrSources = new WeakMap();
  let catalog, lang = 'en';
  const requested = new URLSearchParams(location.search).get('lang');
  try { lang = localStorage.getItem('nav-language') || navigator.language.split('-')[0]; } catch { lang = navigator.language.split('-')[0]; }
  if (supported(requested)) lang = requested;
  if (!supported(lang)) lang = 'en';
  const script = document.querySelector('script[data-nav-i18n]');
  try {
    const response = await fetch(script.dataset.catalog, { credentials: 'same-origin' });
    if (!response.ok) throw Error('catalog unavailable');
    catalog = await response.json();
  } catch { return; } // Original English remains readable if localization is unavailable.
  const patterns = Object.keys(catalog.zh || {}).filter(key => key.includes('{{') && key.replace(/\{\{\d+\}\}/g, '').replace(/[^A-Za-z]/g, '').length >= 5)
    .sort((a, b) => b.replace(/\{\{\d+\}\}/g, '').length - a.replace(/\{\{\d+\}\}/g, '').length)
    .map(key => ({ key, match: new RegExp('^' + key.split(/\{\{\d+\}\}/g).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+?)') + '$') }));
  function translate(text, nested = false) {
    if (lang === 'en') return text;
    let { key, values } = template(text);
    let result = catalog[lang]?.[key];
    // Public UI templates can include source labels as well as numbers. Captures
    // stay local and verbatim unless they themselves have an exact translation.
    if (!result && !nested) {
      const normalized = normalize(text);
      for (const pattern of patterns) {
        const match = normalized.match(pattern.match);
        if (match) { result = catalog[lang]?.[pattern.key]; values = match.slice(1).map(value => translate(value, true)); break; }
      }
      if (!result && normalized.includes(' · ')) return text.split(' · ').map(part => translate(part, true)).join(' · ');
    }
    if (!result) return text;
    return text.match(/^\s*/)[0] + result.replace(/\{\{(\d+)\}\}/g, (_, n) => values[Number(n)] ?? '') + text.match(/\s*$/)[0];
  }
  const excluded = element => element?.closest('script,style,code,pre,svg,canvas,[data-no-translate],[translate="no"]');
  function textNode(node) {
    if (!node.parentElement || excluded(node.parentElement)) return;
    if (!source.has(node) || (node.data !== rendered.get(node) && node.data !== source.get(node))) source.set(node, node.data);
    const next = translate(source.get(node));
    rendered.set(node, next);
    if (node.data !== next) node.data = next;
    if (node.parentElement.childNodes.length === 1) {
      const numeric = /^[+\-$€]?\d[\d.,:/%$+\-\sKMB]*$/.test(normalize(source.get(node)));
      if (numeric) node.parentElement.dataset.navNumeric = '';
      else delete node.parentElement.dataset.navNumeric;
    }
  }
  function attributes(element) {
    if (excluded(element)) return;
    let values = attrSources.get(element);
    if (!values) { values = {}; attrSources.set(element, values); }
    for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) {
      if (!element.hasAttribute(attribute)) continue;
      const current = element.getAttribute(attribute), previous = values[attribute];
      const original = previous && current === previous.rendered ? previous.source : current;
      const next = translate(original); values[attribute] = { source: original, rendered: next };
      if (current !== next) element.setAttribute(attribute, next);
    }
  }
  function walk(root) {
    if (root.nodeType === Node.TEXT_NODE) { textNode(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE || excluded(root)) return;
    attributes(root);
    const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node; while ((node = nodes.nextNode())) node.nodeType === Node.TEXT_NODE ? textNode(node) : attributes(node);
  }
  const chartLabels = new WeakMap();
  const tooltipWrappers = new WeakSet();
  function charts() {
    for (const chart of Object.values(window.Chart?.instances || {})) {
      let changed = false;
      const callbacks = chart.options.plugins?.tooltip?.callbacks;
      if (callbacks && typeof callbacks.label === 'function' && !tooltipWrappers.has(callbacks.label)) {
        const original = callbacks.label;
        const wrapped = function (...args) {
          const value = original.apply(this, args);
          return typeof value === 'string' ? translate(value) : Array.isArray(value) ? value.map(text => typeof text === 'string' ? translate(text) : text) : value;
        };
        tooltipWrappers.add(wrapped); callbacks.label = wrapped;
      }
      for (const dataset of chart.data.datasets || []) {
        if (typeof dataset.label !== 'string') continue;
        const previous = chartLabels.get(dataset);
        const original = previous && dataset.label === previous.rendered ? previous.source : dataset.label;
        const next = translate(original); chartLabels.set(dataset, { source: original, rendered: next });
        if (dataset.label !== next) { dataset.label = next; changed = true; }
      }
      if (changed) chart.update('none');
    }
  }
  const control = document.createElement('select'); control.id = 'nav-language'; control.dataset.noTranslate = '';
  control.setAttribute('aria-label', 'Language / 语言 / भाषा / Idioma / اللغة');
  for (const [code, label] of Object.entries(languages)) { const option = document.createElement('option'); option.value = code; option.textContent = label; control.append(option); }
  const header = document.querySelector('.site-bar-inner') || document.querySelector('header');
  if (header) header.append(control);
  function apply(next) {
    lang = next; control.value = lang;
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    walk(document.querySelector('title'));
    walk(document.body); charts();
    try { localStorage.setItem('nav-language', lang); } catch { /* storage unavailable */ }
  }
  control.addEventListener('change', () => {
    const url = new URL(location.href); url.searchParams.set('lang', control.value); history.replaceState(null, '', url);
    apply(control.value);
  });
  apply(lang);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData' && record.target.data !== rendered.get(record.target)) textNode(record.target);
      if (record.type === 'childList') for (const node of record.addedNodes) walk(node);
      if (record.type === 'attributes') attributes(record.target);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder', 'alt'] });
  observer.observe(document.querySelector('title'), { subtree: true, childList: true, characterData: true });
  setInterval(() => { if (!document.hidden) charts(); }, 1500);
  window.navLocalization = { language: () => lang, translate, template };
})();
