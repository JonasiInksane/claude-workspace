// Tests for the Inbox images view (views/images.js) in a stand-in DOM (test/dom.mjs): it names
// itself Inbox images (it left the nav, and Assets opens it under that name), its crumb leads back
// to Assets, and the gallery of the chosen folder still loads. Run: node tools/run-tests.mjs workspace-app
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, installDom, settle, textOf } from '../../test/dom.mjs';

const dom = installDom();
after(() => dom.uninstall());
const calls = fakeFetch(path => (path.startsWith('/api/images?')
  ? { ok: true, dir: 'C:\\ws\\inbox\\attachments\\_hub', images: [] }
  : { ok: true }));
const store = await import('../store.js');
const { default: images } = await import('./images.js');

test('Inbox images: its name, a crumb back to Assets, and the chosen folder\'s gallery', async () => {
  store.setState({ root: 'C:\\ws', tools: {}, projects: [{ name: 'notes', agents: [] }], flows: [], assets: [] });
  const el = dom.document.createElement('section');
  dom.document.body.append(el);
  images.render(el, { state: store.state, sub: '' });
  assert.equal(images.label, 'Inbox images');
  assert.equal(el.querySelector('h2').textContent, 'Inbox images');
  const crumb = el.querySelector('.crumb button');
  assert.equal(textOf(el.querySelector('.crumb')), 'Assets / Inbox images');
  assert.equal(crumb.getAttribute('type'), 'button');
  dom.click(crumb);
  assert.equal(dom.location.hash, '#assets', 'the crumb opens Assets');
  await settle(5);
  assert.ok(calls.some(c => c.path === '/api/images?hub=1'), 'the hub folder is the default target');
  assert.match(textOf(el), /No images here yet/);
});
