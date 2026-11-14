// Generates tiny synthetic binary STL ArrayBuffers in the browser so students and teachers
// can try a passing model, a floating-part model, and an oversized/long model with one click.

export function makePassingExampleStl() {
  // A 28 x 28 x 12 mm trophy base with a 14 x 14 x 16 mm top column (overlapping by 2 mm so connected)
  const tris = [
    ...boxTris(-14, -14, 0, 14, 14, 12),
    ...boxTris(-7, -7, 10, 7, 7, 24),
  ];
  return encodeBinaryStl(tris, "Sample_Passing_Trophy");
}

export function makeFloatingExampleStl() {
  // Base box + a second box floating 8 mm in the air above it
  const tris = [
    ...boxTris(-15, -15, 0, 15, 15, 10),
    ...boxTris(-8, -8, 18, 8, 8, 28),
  ];
  return encodeBinaryStl(tris, "Sample_Floating_Error");
}

export function makeTooSlowExampleStl() {
  // Large 110 x 110 x 45 mm block that exceeds the 30-minute class print time limit
  const tris = [
    ...boxTris(-55, -55, 0, 55, 55, 45),
  ];
  return encodeBinaryStl(tris, "Sample_Too_Long_Block");
}

export function boxTris(x0, y0, z0, x1, y1, z1) {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [0, 3, 2, 1], // bottom (-Z)
    [4, 5, 6, 7], // top (+Z)
    [0, 1, 5, 4], // front (-Y)
    [2, 3, 7, 6], // back (+Y)
    [3, 0, 4, 7], // left (-X)
    [1, 2, 6, 5], // right (+X)
  ];
  const out = [];
  for (const [a, b, c, d] of quads) {
    out.push([v[a], v[b], v[c]], [v[a], v[c], v[d]]);
  }
  return out;
}

export function encodeBinaryStl(tris, name = "model") {
  const n = tris.length;
  const buf = new ArrayBuffer(84 + n * 50);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < Math.min(80, name.length); i++) u8[i] = name.charCodeAt(i);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / len, true);
    dv.setFloat32(o + 4, ny / len, true);
    dv.setFloat32(o + 8, nz / len, true);
    o += 12;
    for (const p of [a, b, c]) {
      dv.setFloat32(o, p[0], true);
      dv.setFloat32(o + 4, p[1], true);
      dv.setFloat32(o + 8, p[2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}
