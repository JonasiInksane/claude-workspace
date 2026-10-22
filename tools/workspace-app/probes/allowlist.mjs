// The non-shop procedure allowlist: router keys that are allowed to run without a shop scope.
//
//   <dataDir>/profiles/<project>.allowlist.json   { version, project, updatedAt, count, source, list }
//
// The list holds router-key ids ("<module>.<nested router>.<key>") as the routerKeys probe
// reports them in values.<probe>.nonShop. It is private (it describes the project's tenant
// boundary), so it lives next to the profile in the data folder and never in the hub. It changes
// only when you click "Rebuild allowlist": allowlistProposal() shows what a fresh scan would add
// and remove, and saveAllowlist() writes the list you accepted. The G0 ratchet then fails any new
// non-shop key that isn't on it.
import { projectPaths, readJson, writeJsonAtomic } from '../core/datadir.mjs';

const ID_RE = /^[A-Za-z0-9_$][\w$.-]{0,199}$/;
const MAX_ENTRIES = 5000;

// A clean, sorted, de-duplicated list. Throws on an entry that isn't a router-key id.
function cleanList(list) {
  if (!Array.isArray(list)) throw new Error('The allowlist must be a list of procedure ids.');
  if (list.length > MAX_ENTRIES) throw new Error(`The allowlist has more than ${MAX_ENTRIES} entries.`);
  for (const id of list) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`"${id}" is not a procedure id like "module.key".`);
  }
  return [...new Set(list)].sort();
}

// The values entry holding the non-shop list: `probe` when given, else "procedures", else the
// first unfiltered router-keys entry.
function nonShopEntry(values, probe) {
  if (!values || typeof values !== 'object') return null;
  const has = id => values[id] && Array.isArray(values[id].nonShop);
  if (probe) return has(probe) ? values[probe] : null;
  if (has('procedures')) return values.procedures;
  const id = Object.keys(values).find(k => has(k) && !values[k].filtered);
  return id ? values[id] : null;
}

// What saving a fresh allowlist from `scan` (a scan result or a stored scan) would change.
// `current` is the saved list (or the file object, or null when there is none yet).
// Returns { add, remove, list, setUp }: `list` is what saveAllowlist would write.
export function allowlistProposal(scan, current, { probe = null } = {}) {
  const entry = nonShopEntry(scan && scan.values, probe);
  if (!entry) throw new Error('The scan has no procedure list. Run the architecture check with a routerKeys probe first.');
  const list = cleanList(entry.nonShop);
  const cur = current === null || current === undefined ? null : cleanList(Array.isArray(current) ? current : current.list);
  const now = new Set(list);
  const before = new Set(cur || []);
  return {
    add: list.filter(id => !before.has(id)),
    remove: (cur || []).filter(id => !now.has(id)),
    list,
    setUp: cur !== null,
  };
}

// The saved allowlist as a sorted list, or null when none was saved yet.
export async function loadAllowlist(dataDir, project) {
  const file = projectPaths(dataDir, project).allowlist;
  const doc = await readJson(file, null);
  if (doc === null) return null;
  if (!doc || !Array.isArray(doc.list)) throw new Error(`${file} has no list.`);
  return cleanList(doc.list);
}

// Writes the allowlist you accepted. `source` records where it came from ({ scanId, sha }).
// Returns { path, count }.
export async function saveAllowlist(dataDir, project, list, { source = null } = {}) {
  const file = projectPaths(dataDir, project).allowlist;
  const clean = cleanList(list);
  await writeJsonAtomic(file, {
    version: 1,
    project,
    updatedAt: new Date().toISOString(),
    count: clean.length,
    source: source && typeof source === 'object' ? source : null,
    list: clean,
  });
  return { path: file, count: clean.length };
}
