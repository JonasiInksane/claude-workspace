// Prints its arguments as JSON (synthetic). The shim test points the tg-check script at this file
// to see exactly which arguments Git Bash hands to node.
process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\n`);
