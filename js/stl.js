// STL parsing (binary + ASCII). Returns a Float32Array of 9 floats per triangle
// (three vertices, x y z each) in millimetres, exactly as stored in the file.

export class StlError extends Error {}

export function parseStl(buffer) {
  const pos = parseRaw(buffer);
  // NaN/Infinity would poison the bounding box and every later check.
  for (let i = 0; i < pos.length; i++) {
    if (!Number.isFinite(pos[i])) throw new StlError("This STL contains invalid numbers. Export it again from Tinkercad.");
  }
  return pos;
}

function parseRaw(buffer) {
  if (!(buffer instanceof ArrayBuffer)) buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 15) throw new StlError("The file is empty or too small to be a 3D model.");

  // Binary STL: 80-byte header, uint32 count, 50 bytes per triangle. Some binary files
  // start with "solid" in the header, so trust the size match first.
  if (bytes.length >= 84) {
    const n = new DataView(buffer).getUint32(80, true);
    if (n > 0 && 84 + n * 50 === bytes.length) return readBinary(buffer, n);
  }
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  if (head.toLowerCase().startsWith("solid")) {
    const tris = readAscii(new TextDecoder().decode(bytes));
    if (tris.length) return tris;
  }
  if (bytes.length >= 84) {
    const n = new DataView(buffer).getUint32(80, true);
    if (n > 0 && 84 + n * 50 <= bytes.length) return readBinary(buffer, n); // trailing bytes tolerated
  }
  throw new StlError("This doesn't look like an STL file. In Tinkercad, click Export and choose .STL.");
}

function readBinary(buffer, n) {
  const dv = new DataView(buffer);
  const out = new Float32Array(n * 9);
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12; // skip stored normal; we recompute from winding
    for (let k = 0; k < 9; k++) { out[i * 9 + k] = dv.getFloat32(o, true); o += 4; }
    o += 2;
  }
  return out;
}

function readAscii(text) {
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/gi; // some exporters shout VERTEX
  const vals = [];
  let m;
  while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
  const n = Math.floor(vals.length / 9);
  return Float32Array.from(vals.slice(0, n * 9));
}

// Binary STL bytes for a Float32Array of 9 floats per triangle (inverse of parseStl).
export function writeBinaryStl(pos) {
  const n = pos.length / 9, dv = new DataView(new ArrayBuffer(84 + n * 50));
  dv.setUint32(80, n, true);
  for (let t = 0; t < n; t++) {
    const p = t * 9, o = 84 + t * 50;
    const ux = pos[p+3]-pos[p], uy = pos[p+4]-pos[p+1], uz = pos[p+5]-pos[p+2];
    const vx = pos[p+6]-pos[p], vy = pos[p+7]-pos[p+1], vz = pos[p+8]-pos[p+2];
    const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx, l = Math.hypot(nx, ny, nz) || 1;
    [nx/l, ny/l, nz/l, ...pos.subarray(p, p + 9)].forEach((x, i) => dv.setFloat32(o + i * 4, x, true));
  }
  return dv.buffer;
}
