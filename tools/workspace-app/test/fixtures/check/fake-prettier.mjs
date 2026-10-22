// A stand-in for `prettier --check <files>` in the check runner tests (synthetic). A file that
// contains UNFORMATTED is reported the way Prettier reports it, and the exit code is 1.
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
process.stdout.write('Checking formatting...\n');
const bad = files.filter(f => readFileSync(f, 'utf8').includes('UNFORMATTED'));
for (const f of bad) process.stderr.write(`[warn] ${f}\n`);
if (bad.length) process.stderr.write('[warn] Code style issues found in the above file. Run Prettier with --write to fix.\n');
process.exit(bad.length ? 1 : 0);
