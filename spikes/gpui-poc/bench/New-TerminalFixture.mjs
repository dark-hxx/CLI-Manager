// Fixed input only. Running this script does not measure PTY or rendering throughput.
import { createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const lineBytes = 128;
const chunkLines = 8192;

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return null;
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--bytes', '--output'].includes(key) || !value || options.has(key)) {
      throw new Error('Expected --output <new-file> [--bytes <positive-integer>].');
    }
    options.set(key, value);
  }
  if (!options.has('--output')) throw new Error('--output is required.');
  const size = options.get('--bytes') ?? '100000000';
  if (!/^[1-9][0-9]*$/.test(size) || !Number.isSafeInteger(Number(size)) ||
      Number(size) > 2_147_483_648) {
    throw new Error('--bytes must be an integer from 1 to 2147483648.');
  }
  return { byteCount: Number(size), destination: resolve(options.get('--output')) };
}

function makeLine(sequence) {
  const prefix = `M0 ${String(sequence).padStart(12, '0')} `;
  const text = `${prefix}terminal throughput baseline: project/session output 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ`;
  return Buffer.from(`${text.padEnd(lineBytes - 1, '.')}\n`, 'ascii');
}

async function generate({ byteCount, destination }) {
  const manifestPath = `${destination}.json`;
  const ownedPaths = [];
  let manifestHandle;
  let outputHandle;
  let complete = false;
  const digest = createHash('sha256');
  try {
    await mkdir(dirname(destination), { recursive: true });
    // Exclusive creation protects existing fixtures and sidecars, including on partial failure.
    manifestHandle = await open(manifestPath, 'wx');
    ownedPaths.push(manifestPath);
    outputHandle = await open(destination, 'wx');
    ownedPaths.push(destination);
    async function* chunks() {
      let remaining = byteCount;
      let sequence = 0;
      while (remaining > 0) {
        const length = Math.min(chunkLines * lineBytes, remaining);
        const chunk = Buffer.allocUnsafe(length);
        let offset = 0;
        while (offset < length) {
          const line = makeLine(sequence++);
          const take = Math.min(line.length, length - offset);
          line.copy(chunk, offset, 0, take);
          offset += take;
        }
        // A short final record also ends in LF; the requested byte count stays exact.
        chunk[chunk.length - 1] = 10;
        digest.update(chunk);
        remaining -= length;
        yield chunk;
      }
    }
    await pipeline(chunks(), outputHandle.createWriteStream());
    const manifest = {
      schemaVersion: 1,
      generator: 'm0-fixed-text-v1',
      file: basename(destination),
      byteCount,
      sha256: digest.digest('hex'),
      encoding: 'ASCII (UTF-8 subset)',
      lineEnding: 'LF',
      lineBytes,
      lineCount: Math.ceil(byteCount / lineBytes),
      finalLineBytes: byteCount % lineBytes || lineBytes,
      ansi: false,
      formalBaseline: false,
      scope: 'Input generation only; no PTY, parser, renderer, frame, or latency timing.',
    };
    await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    complete = true;
    console.log(`Created ${byteCount} bytes: ${destination}`);
    console.log(`SHA-256: ${manifest.sha256}`);
  } finally {
    await Promise.all([manifestHandle?.close(), outputHandle?.close()]);
    if (!complete) {
      for (const path of ownedPaths.reverse()) await rm(path, { force: true });
    }
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options) await generate(options);
  else console.log('node New-TerminalFixture.mjs --output <new-file> [--bytes 100000000]');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
