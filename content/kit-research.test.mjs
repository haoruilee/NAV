import test from 'node:test';
import assert from 'node:assert/strict';
import {kitLanguages, kitResearchPanel} from './kit-research.mjs';
test('five KiT language links retain research and execution boundaries', () => {
  const html=kitResearchPanel();
  assert.equal(kitLanguages.length,5);
  for(const [lang] of kitLanguages) {
    assert.ok(html.includes(`https://trading.etfnav.org/?lang=${lang}`));
    assert.ok(html.includes(`https://trading.etfnav.org/strategies?lang=${lang}`));
  }
  assert.ok(html.includes('dir="rtl"'));
  assert.ok(html.includes('does not affect NAV Monitor'));
  assert.ok(html.includes('not connected to a broker'));
  assert.ok(!/41\.9%|96%|2\.1%/.test(html));
});
