import { readdir, readFile, access } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const skip = new Set(['node_modules', '.git', 'coverage']);
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile() && extname(entry.name) === '.js') files.push(full);
  }
}
await walk(root);
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(`${relative(root, file)}\n${result.stderr || result.stdout}`);
  }
}
const html = await readFile(join(root, 'index.html'), 'utf8');
const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
if (duplicates.length) {
  failed++;
  console.error(`Duplicate HTML IDs: ${duplicates.join(', ')}`);
}
for (const [, src] of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
  if (/^https?:|^data:/.test(src) || src === '/socket.io/socket.io.min.js') continue;
  try { await access(join(root, src.replace(/^\//, ''))); }
  catch { failed++; console.error(`Missing script referenced by index.html: ${src}`); }
}
for (const [, href] of html.matchAll(/<link[^>]+href=["']([^"']+)["']/g)) {
  if (/^https?:|^data:|^#/.test(href)) continue;
  try { await access(join(root, href.replace(/^\//, ''))); }
  catch { failed++; console.error(`Missing stylesheet/resource referenced by index.html: ${href}`); }
}
console.log(`JavaScript files checked: ${files.length}`);
console.log(`HTML IDs checked: ${ids.length}`);
console.log(`Duplicate IDs: ${duplicates.length}`);
console.log(`Source verification: ${failed ? 'FAILED' : 'PASSED'}`);
process.exitCode = failed ? 1 : 0;
