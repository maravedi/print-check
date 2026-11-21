// OrcaSlicer / Bambu Studio project (.3mf) with colour-change pauses already placed.
// A process preset (.json) cannot carry per-layer pauses: Orca keeps them in the project file
// (Metadata/custom_gcode_per_layer.xml), so this writes the parts, the pause(s) and a per-object
// layer height that keeps the pause on the intended layer whatever process preset is selected.
// Verified with the OrcaSlicer CLI: the sliced G-code gets ";PAUSE_PRINT" + the printer's pause
// G-code (M25 on the AD5M) right after the layer change to each top_z.

import { buildMesh } from "./mesh.js";

const PAUSE_PRINT = 1; // Orca CustomGCode::Type: 0 colour change, 1 pause, 2 tool change, 3 template, 4 custom
const GAP = 4; // mm between parts on the plate
// The OrcaSlicer GUI keeps per-layer pauses only from a Bambu/Orca project: without this tag it logs
// "found 3mf from other vendor", skips custom_gcode_per_layer.xml and imports geometry only.
// (The CLI reads the pauses either way, so a CLI slice alone does not prove the GUI sees them.)
// Orca itself writes this value, plus the plate list in model_settings.config.
const APPLICATION = "BambuStudio-02.06.00.51";
const ORCA_VERSION = "2.4.2";

// parts: [{ name, pos }] with pos the STL triangle soup (Float32Array, 9 floats per triangle).
// pauseZ: Orca layer tops (traits.colorChanges[i].layerTopMm) to pause before printing.
// projectSettings: an Orca project_settings.config object (e.g. js/orca-project-ad5m.json). Required for the
// OrcaSlicer GUI to keep the pause: a .3mf without settings is loaded as geometry only and the pause is dropped.
export function buildPauseProject(parts, { pauseZ = [], layerHeight = 0.12, bed = [220, 220], projectSettings = null } = {}) {
  // Bed centre: from the printer's printable_area when known (the AD5M's origin is the bed centre).
  let cx = bed[0] / 2, cy = bed[1] / 2;
  if (projectSettings?.printable_area) {
    const pts = projectSettings.printable_area.map((p) => p.split("x").map(Number));
    cx = (Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2;
    cy = (Math.min(...pts.map((p) => p[1])) + Math.max(...pts.map((p) => p[1]))) / 2;
  }
  const meshes = parts.map(({ name, pos }) => {
    const m = buildMesh(pos);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.nV; i++) for (let k = 0; k < 3; k++) {
      const v = m.V[i * 3 + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v;
    }
    return { name, m, lo, hi };
  });
  // One row along X, centred on the bed, each part resting on z = 0.
  const width = meshes.reduce((s, p) => s + p.hi[0] - p.lo[0], 0) + GAP * (meshes.length - 1);
  let x = cx - width / 2;
  const items = meshes.map((p) => {
    const tx = x - p.lo[0], ty = cy - (p.lo[1] + p.hi[1]) / 2, tz = -p.lo[2];
    x += p.hi[0] - p.lo[0] + GAP;
    return [tx, ty, tz];
  });

  const xmlEsc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
  const f = (n) => +n.toFixed(5);
  const objects = meshes.map(({ name, m }, i) => {
    const v = [], t = [];
    for (let j = 0; j < m.nV; j++) v.push(`<vertex x="${f(m.V[j * 3])}" y="${f(m.V[j * 3 + 1])}" z="${f(m.V[j * 3 + 2])}"/>`);
    for (let j = 0; j < m.nT; j++) t.push(`<triangle v1="${m.F[j * 3]}" v2="${m.F[j * 3 + 1]}" v3="${m.F[j * 3 + 2]}"/>`);
    return `<object id="${i + 1}" name="${xmlEsc(name)}" type="model"><mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
<metadata name="Application">${APPLICATION}</metadata>
<metadata name="OrcaSlicer">${ORCA_VERSION}</metadata>
<metadata name="BambuStudio:3mfVersion">1</metadata>
<resources>${objects.join("\n")}</resources>
<build>${items.map(([tx, ty, tz], i) => `<item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${f(tx)} ${f(ty)} ${f(tz)}"/>`).join("")}</build>
</model>`;
  const settings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
${meshes.map(({ name }, i) => `<object id="${i + 1}">
<metadata key="name" value="${xmlEsc(name)}"/>
<metadata key="layer_height" value="${layerHeight}"/>
</object>`).join("\n")}
<plate>
<metadata key="plater_id" value="1"/>
<metadata key="plater_name" value=""/>
<metadata key="locked" value="false"/>
${meshes.map((_, i) => `<model_instance>
<metadata key="object_id" value="${i + 1}"/>
<metadata key="instance_id" value="0"/>
</model_instance>`).join("\n")}
</plate>
</config>`;
  const pauses = `<?xml version="1.0" encoding="utf-8"?>
<custom_gcodes_per_layer>
<plate>
<plate_info id="1"/>
${pauseZ.map((z) => `<layer top_z="${z}" type="${PAUSE_PRINT}" extruder="1" color="" extra="" gcode=""/>`).join("\n")}
<mode value="SingleExtruder"/>
</plate>
</custom_gcodes_per_layer>`;

  return zipStore([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="config" ContentType="text/xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`],
    ["3D/3dmodel.model", model],
    ["Metadata/model_settings.config", settings],
    ["Metadata/custom_gcode_per_layer.xml", pauses],
    ...(projectSettings ? [["Metadata/project_settings.config", JSON.stringify({ ...projectSettings, layer_height: String(layerHeight) }, null, 1)]] : []),
  ]);
}

// Minimal uncompressed ZIP (method 0). 3MF readers accept stored entries; no dependency needed.
let crcTable;
function crc32(b) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(entries) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameB = enc.encode(name), data = typeof text === "string" ? enc.encode(text) : text;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameB.length, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameB.length, true); cen.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), nameB, data);
    central.push(new Uint8Array(cen.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}
