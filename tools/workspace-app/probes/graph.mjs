// Import graphs for the cycles probe: strongly connected components and the module-level graph.
//
// A graph is a plain object (or a Map) from a node name to the names it points at, the shape madge
// prints with --json: { "src/a.ts": ["src/b.ts"], ... }. A name that only appears as a target is a
// node with no edges of its own.
//
// scc() is Tarjan's algorithm written with an explicit stack, so a long import chain (thousands of
// files deep) can't overflow the JavaScript call stack. A strongly connected component with more
// than one node is an import cycle; a file that imports itself is ignored.
// moduleGraph() folds a file graph into a graph of modules ("src/modules/<name>/..."), keeping only
// the edges between two different modules, which is what "the largest module cycle" is measured on.

function toMap(adj) {
  if (adj instanceof Map) return adj;
  return new Map(Object.entries(adj || {}));
}

function targetsOf(graph, node) {
  const list = graph.get(node);
  return Array.isArray(list) ? list : list instanceof Set ? [...list] : [];
}

// The strongly connected components of a graph, each a sorted array of node names. Components
// are sorted biggest first, then by their first name, so the output is the same on every run.
export function scc(adj) {
  const graph = toMap(adj);
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];
  let next = 0;

  const visit = node => {
    index.set(node, next);
    low.set(node, next);
    next++;
    stack.push(node);
    onStack.add(node);
  };

  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    visit(start);
    const work = [{ node: start, targets: targetsOf(graph, start), i: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.i < frame.targets.length) {
        const w = frame.targets[frame.i++];
        if (!index.has(w)) {
          visit(w);
          work.push({ node: w, targets: targetsOf(graph, w), i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(w)));
        }
        continue;
      }
      work.pop();
      const v = frame.node;
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
      if (low.get(v) === index.get(v)) {
        const comp = [];
        let w;
        do {
          w = stack.pop();
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        out.push(comp.sort());
      }
    }
  }
  return out.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// Only the components that are real cycles (two or more nodes).
export function cyclesOf(adj) {
  return scc(adj).filter(c => c.length > 1);
}

// The module of a file: the first capture group of the regex (or the whole match), or null.
export function moduleOf(file, moduleRegex) {
  const m = moduleRegex.exec(file);
  return m ? (m[1] ?? m[0]) : null;
}

function plainRegex(moduleRegex) {
  const re = moduleRegex instanceof RegExp ? moduleRegex : new RegExp(String(moduleRegex));
  // A global or sticky regex keeps state between exec() calls; a fresh copy without them doesn't.
  return new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
}

// Folds a file graph into a module graph: { module: [other modules it imports], ... } with sorted
// lists. Files the regex doesn't match are left out, and so are imports inside one module. A module
// with no outgoing edges is still a key, so the key count is the module count.
export function moduleGraph(fileGraph, moduleRegex) {
  const re = plainRegex(moduleRegex);
  const graph = toMap(fileGraph);
  const edges = new Map();
  const add = name => {
    if (!edges.has(name)) edges.set(name, new Set());
    return edges.get(name);
  };
  for (const file of graph.keys()) {
    const from = moduleOf(file, re);
    if (!from) continue;
    const out = add(from);
    for (const dep of targetsOf(graph, file)) {
      const to = moduleOf(dep, re);
      if (!to) continue;
      add(to);
      if (to !== from) out.add(to);
    }
  }
  const result = {};
  for (const name of [...edges.keys()].sort()) result[name] = [...edges.get(name)].sort();
  return result;
}
