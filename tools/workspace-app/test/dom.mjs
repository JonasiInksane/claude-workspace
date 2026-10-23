// A small stand-in for the browser DOM, so tests can render the page's modules (ui/*.js) in Node
// and look at what they built: elements with attributes, classes, dataset and children, text
// nodes, events that bubble, focus, and querySelector with the selectors the page uses (tag, #id,
// .class, [attr], [attr="value"], lists with commas and descendants with spaces). Not a browser:
// no layout, no CSS, no form behaviour; a test dispatches the events it needs itself.
//
//   const dom = installDom();   // sets globalThis.document, window, Node, location, history
//   ... import the module under test, render into dom.document.createElement('section') ...
//   dom.key(target, 'ArrowRight'); dom.click(button); dom.document.activeElement
//   dom.uninstall();            // puts the old globals back
//
// Test helper only: it is not served to the page and not a test file itself.

const kebab = s => s.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

export class FakeNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; this.listeners = new Map(); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.documentElement; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(...(v === '' || v == null ? [] : [this.ownerDocument.createTextNode(String(v))])); }
  appendChild(node) { return this.insertBefore(node, null); }
  append(...nodes) { for (const n of nodes) this.appendChild(n instanceof FakeNode ? n : this.ownerDocument.createTextNode(String(n))); }
  insertBefore(node, ref) {
    if (node.parentNode) node.remove();
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(node);
    else this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
    const doc = this.ownerDocument;
    if (doc.activeElement && (doc.activeElement === this || this.contains(doc.activeElement))) doc.activeElement = doc.body;
  }
  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) c.remove();
    this.append(...nodes);
  }
  replaceWith(node) {
    const p = this.parentNode;
    if (!p) return;
    p.insertBefore(node, this);
    this.remove();
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); }
  // Runs the listeners here, then on every parent while the event bubbles.
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    for (let n = this; n; n = event.bubbles === false ? null : n.parentNode) {
      event.currentTarget = n;
      for (const fn of [...(n.listeners.get(event.type) || [])]) fn.call(n, event);
      if (event.stopped) break;
    }
    return !event.defaultPrevented;
  }
}

export class FakeText extends FakeNode {
  constructor(doc, text) { super(doc); this.data = String(text); this.nodeType = 3; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

// One compound selector ('details.menu[open]', '#x', '[data-key="a"]') against one element.
function matchesCompound(el, sel) {
  if (!(el instanceof FakeElement)) return false;
  const re = /([#.]?[\w-]+|\*|\[[^\]]+\])/g;
  let m;
  let any = false;
  while ((m = re.exec(sel))) {
    any = true;
    const part = m[1];
    if (part === '*') continue;
    if (part[0] === '#') { if (el.getAttribute('id') !== part.slice(1)) return false; }
    else if (part[0] === '.') { if (!el.classList.contains(part.slice(1))) return false; }
    else if (part[0] === '[') {
      const a = /^\[\s*([\w-]+)\s*(?:=\s*["']?([^"'\]]*)["']?)?\s*\]$/.exec(part);
      if (!a) return false;
      const value = a[1] === 'open' || a[1] === 'hidden' || a[1] === 'disabled' ? (el[a[1]] ? '' : null) : el.getAttribute(a[1]);
      if (value === null || value === undefined) return false;
      if (a[2] !== undefined && value !== a[2]) return false;
    } else if (el.tagName !== part.toUpperCase()) return false;
  }
  return any;
}

// A selector with commas and descendant spaces, against one element.
function matchesSelector(el, selector) {
  return selector.split(',').map(s => s.trim()).filter(Boolean).some(s => {
    const steps = s.split(/\s+/);
    if (!matchesCompound(el, steps[steps.length - 1])) return false;
    let node = el.parentNode;
    for (let i = steps.length - 2; i >= 0; i--) {
      while (node && !matchesCompound(node, steps[i])) node = node.parentNode;
      if (!node) return false;
      node = node.parentNode;
    }
    return true;
  });
}

export class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.style = {};
    // The boolean properties h() sets only when true start false, as in a browser.
    Object.assign(this, { disabled: false, hidden: false, checked: false, open: false, selected: false });
    const self = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => (typeof k === 'string' ? self.getAttribute(`data-${kebab(k)}`) ?? undefined : undefined),
      set: (_, k, v) => { self.setAttribute(`data-${kebab(String(k))}`, String(v)); return true; },
      has: (_, k) => self.attributes.has(`data-${kebab(String(k))}`),
      deleteProperty: (_, k) => { self.removeAttribute(`data-${kebab(String(k))}`); return true; },
    });
  }
  get children() { return this.childNodes.filter(c => c instanceof FakeElement); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', String(v)); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', String(v)); }
  get tabIndex() { const t = this.getAttribute('tabindex'); return t === null ? -1 : Number(t); }
  set tabIndex(v) { this.setAttribute('tabindex', String(v)); }
  // A form control's value: what was typed (set), else its value attribute, else ''.
  get value() { return this.typed ?? this.getAttribute('value') ?? ''; }
  set value(v) { this.typed = String(v); }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      contains: c => list().includes(c),
      add: (...cs) => { el.className = [...new Set([...list(), ...cs])].join(' '); },
      remove: (...cs) => { el.className = list().filter(x => !cs.includes(x)).join(' '); },
      toggle: (c, force) => {
        const on = force === undefined ? !list().includes(c) : !!force;
        if (on) el.classList.add(c); else el.classList.remove(c);
        return on;
      },
    };
  }
  setAttribute(k, v) { this.attributes.set(String(k).toLowerCase(), String(v)); }
  getAttribute(k) { const v = this.attributes.get(String(k).toLowerCase()); return v === undefined ? null : v; }
  hasAttribute(k) { return this.attributes.has(String(k).toLowerCase()); }
  removeAttribute(k) { this.attributes.delete(String(k).toLowerCase()); }
  matches(sel) { return matchesSelector(this, sel); }
  closest(sel) { for (let n = this; n instanceof FakeElement; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = n => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.dispatchEvent(fakeEvent('click')); }
  // <dialog>: open and close (close fires its close event).
  showModal() { this.open = true; }
  show() { this.open = true; }
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(fakeEvent('close', { bubbles: false }));
  }
  // icon(): a <template> whose markup becomes one <svg> element (the markup itself is not parsed).
  set innerHTML(markup) {
    this.markup = String(markup);
    if (this.tagName === 'TEMPLATE') {
      const svg = new FakeElement(this.ownerDocument, 'svg');
      svg.markup = this.markup;
      this.content = { firstChild: svg };
    }
  }
  get innerHTML() { return this.markup || ''; }
}

// Elements a browser lays out as blocks: their edges separate words, as innerText does.
const BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FORM', 'H1', 'H2', 'H3', 'H4',
  'H5', 'H6', 'HEADER', 'FOOTER', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL']);

// The text a reader sees in `node`, on one line: a block's edges become spaces, runs of space
// collapse, inline elements (a <code> in a sentence) join their neighbours as they are.
export function textOf(node) {
  const parts = [];
  const walk = n => {
    if (n instanceof FakeText) { parts.push(n.data); return; }
    const block = n instanceof FakeElement && BLOCKS.has(n.tagName);
    if (block) parts.push(' ');
    for (const c of n.childNodes) walk(c);
    if (block) parts.push(' ');
  };
  walk(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export function fakeEvent(type, props = {}) {
  return {
    type, bubbles: true, defaultPrevented: false, stopped: false, target: null, currentTarget: null,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    ...props,
  };
}

export class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.documentElement = new FakeElement(this, 'html');
    this.body = new FakeElement(this, 'body');
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.hidden = false;
    this.title = '';
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createElementNS(_ns, tag) { return new FakeElement(this, tag); }
  createTextNode(text) { return new FakeText(this, text); }
  querySelector(sel) { return this.documentElement.matches(sel) ? this.documentElement : this.documentElement.querySelector(sel); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
  getElementById(id) { return this.querySelector(`#${id}`); }
}

// An answer with another status than 200, for fakeFetch: reply(404, { ok: false, error: '...' }).
const REPLY = Symbol('reply');
export const reply = (status, body) => ({ [REPLY]: true, status, body });

// globalThis.fetch for api() in lib.js: `answer(path, { method, body })` returns the JSON body
// (status 200) or a reply(); a thrown error is a network failure. Every call is kept in the
// returned list as { path, method, body }.
export function fakeFetch(answer) {
  const calls = [];
  globalThis.fetch = async (path, opts = {}) => {
    const call = { path: String(path), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const out = await answer(call.path, call);
    const { status, body } = out && out[REPLY] ? out : { status: 200, body: out };
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: k => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return calls;
}

const realSetTimeout = globalThis.setTimeout;

// A promise that resolves after the pending microtasks and timers of `ms` (default: one turn).
export const settle = (ms = 0) => new Promise(r => realSetTimeout(r, ms));

// Sets the globals the page's modules use and returns helpers; uninstall() restores the old ones
// and clears the timers the page made meanwhile (a toast's 7 s, a poll), so a test file ends at
// once. The document gets the page's <dialog id="dialog">, #toasts and #announcer.
export function installDom({ hash = '' } = {}) {
  const keys = ['document', 'window', 'Node', 'location', 'history', 'HashChangeEvent', 'Event', 'setTimeout', 'setInterval'];
  const old = new Map(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const timers = new Set();
  const realInterval = globalThis.setInterval;
  const track = make => (fn, ms, ...args) => {
    const t = make(fn, ms, ...args);
    timers.add(t);
    return t;
  };
  const document = new FakeDocument();
  const win = new FakeNode(document);
  const location = { hash };
  const history = {
    entries: [hash],
    pushState(_, __, url) { this.entries.push(String(url)); location.hash = String(url); },
    replaceState(_, __, url) { this.entries[this.entries.length - 1] = String(url); location.hash = String(url); },
  };
  const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  set('document', document);
  set('window', win);
  set('Node', FakeNode);
  set('location', location);
  set('history', history);
  set('HashChangeEvent', class { constructor(type) { this.type = type; } });
  set('Event', class { constructor(type, init = {}) { Object.assign(this, fakeEvent(type, init)); } });
  set('setTimeout', track(realSetTimeout));
  set('setInterval', track(realInterval));
  for (const [tag, id] of [['dialog', 'dialog'], ['div', 'toasts'], ['div', 'announcer']]) {
    const el = document.createElement(tag);
    el.id = id;
    document.body.append(el);
  }
  return {
    document, window: win, location, history,
    key(target, key, props = {}) { const e = fakeEvent('keydown', { key, ...props }); target.dispatchEvent(e); return e; },
    click(target) { const e = fakeEvent('click'); target.dispatchEvent(e); return e; },
    uninstall() {
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      timers.clear();
      for (const [k, d] of old) {
        if (d) Object.defineProperty(globalThis, k, d);
        else delete globalThis[k];
      }
    },
  };
}
