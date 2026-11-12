// Source-only builder staging. Never copy server settings, fund data or logs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const target = path.resolve(process.argv[2]);
if (target === root || target === path.dirname(root)) throw Error('Use an isolated build directory');
const hashes = {};
for (const folder of ['content', 'ops', 'ui', 'public/assets']) {
  function copy(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) copy(name);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(path.join(root, name));
        hashes[name] = crypto.createHash('sha256').update(bytes).digest('hex');
        const dest = path.join(target, 'source', name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes);
      }
    }
  }
  copy(folder);
}
fs.writeFileSync(path.join(target, 'inputs.json'), JSON.stringify(hashes, null, 2));
console.log(`Pinned ${Object.keys(hashes).length} public source inputs.`);
