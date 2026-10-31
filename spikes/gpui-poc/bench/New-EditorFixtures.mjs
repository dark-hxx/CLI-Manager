import { mkdir, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('./results/editor-fixtures/', import.meta.url);
await mkdir(root, { recursive: true });
const fixtures = [
  ['source-1MB.ts', 1_000_000, 128, 'export const value = "中文 e\u0301 🙂"; // fixture'],
  ['log-10MB.log', 10_000_000, 256, '2026-10-30T00:00:00Z INFO 中文 e\u0301 🙂 fixture'],
];
for (const [name, bytes, lineBytes, prefix] of fixtures) {
  // Byte aligned padding keeps UTF-8 scalars intact, including the last partial line.
  const body = Buffer.from(prefix, 'utf8');
  const line = Buffer.alloc(lineBytes, 0x20);
  body.copy(line);
  line[line.length - 1] = 0x0a;
  const output = Buffer.alloc(bytes, 0x20);
  for (let offset = 0; offset < bytes; offset += lineBytes) {
    if (bytes - offset >= lineBytes) line.copy(output, offset);
    else output[bytes - 1] = 0x0a;
  }
  const file = await open(new URL(name, root), 'wx');
  try { await file.writeFile(output); } finally { await file.close(); }
  const metadata = { name, bytes, lineBytes, lines: Math.ceil(bytes / lineBytes),
    sha256: createHash('sha256').update(output).digest('hex'),
    note: 'Synthetic repeated fixture; does not prove semantic highlighting or editing.' };
  await writeFile(new URL(`${name}.json`, root), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(metadata));
}
