/**
 * Minimal ZIP reader (stored + deflate entries) using the browser's built-in
 * DecompressionStream — no libraries. Used to unpack update packages.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Map<string, Uint8Array>>} path → file bytes (directories omitted)
 */
export async function unzip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // End of central directory: last 22+ bytes (comment up to 64 KB).
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 22 - 65535); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a valid zip file.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) throw new Error('Corrupt zip (central directory).');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new Error('Encrypted zip entries are not supported.');
    if (name.endsWith('/')) continue;
    if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new Error('Corrupt zip (local header).');
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const data = bytes.subarray(start, start + compSize);
    let file;
    if (method === 0) file = data.slice();
    else if (method === 8) file = await inflateRaw(data);
    else throw new Error(`Unsupported zip compression (method ${method}) for ${name}.`);
    if (file.length !== size) throw new Error(`Corrupt zip entry: ${name}`);
    out.set(name, file);
  }
  return out;
}
