// A stand-in for `tsc --noEmit` in the check runner tests (synthetic). It prints the lines of
// type-errors.txt in its working folder, the way tsc prints errors, and exits 2 when there are
// any. type-crash.txt makes it fail without a readable error, like a broken install.
import { existsSync, readFileSync } from 'node:fs';

if (existsSync('type-crash.txt')) {
  process.stderr.write('fake-tsc: something went wrong before type checking\n');
  process.exit(1);
}
const lines = existsSync('type-errors.txt')
  ? readFileSync('type-errors.txt', 'utf8').split(/\r?\n/).filter(Boolean)
  : [];
for (const line of lines) process.stdout.write(`${line}\n`);
process.exit(lines.length ? 2 : 0);
