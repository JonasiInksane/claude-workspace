// A stand-in for `eslint --format json <files>` in the check runner tests (synthetic). A line
// with LINT_ERROR(<rule>) is an error, LINT_WARN(<rule>) a warning; LINT_CRASH makes it exit 2
// like a broken config. Files are relative to the working folder; filePath is absolute, as in
// ESLint's own JSON.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const files = process.argv.slice(2).filter(a => !a.startsWith('--') && a !== 'json');
const results = [];
let errors = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('LINT_CRASH')) {
    process.stderr.write('fake-eslint: the config could not be loaded\n');
    process.exit(2);
  }
  const messages = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/LINT_(ERROR|WARN)\((\w[\w-]*)\)/g)) {
      const severity = m[1] === 'ERROR' ? 2 : 1;
      if (severity === 2) errors++;
      messages.push({ ruleId: m[2], severity, message: `${m[2]} is not allowed here.`, line: i + 1, column: m.index + 1 });
    }
  });
  results.push({ filePath: resolve(file), messages, errorCount: messages.filter(m => m.severity === 2).length });
}
process.stdout.write(`${JSON.stringify(results)}\n`);
process.exit(errors ? 1 : 0);
