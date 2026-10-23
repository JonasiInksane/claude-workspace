// Repainting without losing the reader's place (SPEC 5.11), for screens that render on every
// store change and again whenever an answer arrives: the project page and its tabs. patch() puts
// exactly the given nodes into a parent and moves none that stay, so the focus, an open <details>
// and typed text survive a refresh; createMemo() hands back the node it built last time while what
// that node shows (its deps, compared as JSON) is unchanged. Moved here from the cockpit view.

// Puts exactly `nodes` (nulls skipped) into `parent`, in order, moving nothing that stays: stale
// children go first, then new nodes are inserted where they belong. A focused control inside a
// node that stays keeps the focus.
export function patch(parent, nodes) {
  const want = nodes.flat().filter(Boolean);
  const keep = new Set(want);
  for (const child of [...parent.childNodes]) if (!keep.has(child)) child.remove();
  want.forEach((node, i) => { if (parent.childNodes[i] !== node) parent.insertBefore(node, parent.childNodes[i] || null); });
  return parent;
}

// A cache of built nodes: memo(key, deps, build) returns the node built last time for `key` while
// the JSON of `deps` is unchanged, and builds it again otherwise.
export function createMemo() {
  const map = new Map();
  return function memo(key, deps, build) {
    const sig = JSON.stringify(deps === undefined ? null : deps);
    const hit = map.get(key);
    if (hit && hit.sig === sig) return hit.el;
    const el = build();
    map.set(key, { sig, el });
    return el;
  };
}

// A container that stays across repaints (one per key), patched child by child.
export function createBlocks(make) {
  const blocks = new Map();
  return function block(key, cls, nodes) {
    if (!blocks.has(key)) blocks.set(key, make(cls));
    return patch(blocks.get(key), nodes);
  };
}
