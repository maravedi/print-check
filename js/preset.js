// Automated 3D print trait analysis and OrcaSlicer / Bambu Studio preset generation.
// Detects embossed low-profile morphology (coins/badges), fine micro-features,
// support/adhesion requirements, optimal layer heights, and multi-color layer pauses.

import { isLowRelief, sectionArea } from "./relief.js";

const FIRST_LAYER = 0.2; // initial_layer_print_height in every generated preset

export function analyzePrintTraits(mesh, size, results, slicerEstimate, printer) {
  const dz = size[2];
  const isRelief = isLowRelief(size);

  // Raised text/detail narrower than a nozzle line: no slicer setting recovers it (see relief.js).
  const reliefCheck = results.find((r) => r.id === "relief-detail");
  const reliefTooFine = reliefCheck?.status === "warn";

  // Wall thickness analysis from check results
  const thinCheck = results.find((r) => r.id === "thin");
  const hasThinFeatures = thinCheck && (thinCheck.status === "warn" || thinCheck.severe);

  // Overhang analysis
  const overhangCheck = results.find((r) => r.id === "overhang");
  const needsSupport = overhangCheck && overhangCheck.status === "warn";

  // Bed contact analysis
  const contactCheck = results.find((r) => r.id === "contact");
  const goodContact = !contactCheck || contactCheck.status === "pass";

  // Recommend layer height:
  // Coins & fine embossed badges need 0.12 mm for crisp vertical relief steps
  // Otherwise standard 0.20 mm
  let recommendedLayerHeight = 0.20;
  if (isRelief || hasThinFeatures) {
    recommendedLayerHeight = 0.12;
  }

  // Wall generator engine:
  // Arachne dynamically scales extrusion line width around text serifs and fine corners
  const wallGenerator = (hasThinFeatures || isRelief) ? "arachne" : "classic";

  // Color swap / layer pause detection from layer-by-layer cross-sectional area
  // Every sharp drop is a candidate: base -> relief, and e.g. rims -> taller face items (pause there to
  // colour only the items that rise above the rest).
  const colorChanges = [];
  if (slicerEstimate?.layerAreas && slicerEstimate?.zLevels) {
    const areas = slicerEstimate.layerAreas;
    const zs = slicerEstimate.zLevels;
    const n = areas.length;
    // Look for sharp drop in area (solid base plate transitioning to raised relief)
    for (let i = 1; i < n - 1; i++) {
      const z = zs[i];
      if (z < 0.5 || z > dz - 0.25) continue;
      const prevArea = areas[i - 1];
      const curArea = areas[i];
      if (prevArea > 50 && curArea > 0 && curArea / prevArea < 0.65) {
        // The estimate samples at its own (0.20 mm) layers; find the real boundary on the mesh,
        // then count layers at the height we recommend, or the pause lands on the wrong layer.
        let lo = zs[i - 1], hi = z;
        if (mesh?.V) {
          const drops = (zz) => sectionArea(mesh, zz) < 0.65 * prevArea;
          for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2; if (drops(mid)) hi = mid; else lo = mid; }
        }
        const boundary = (lo + hi) / 2;
        const lh = recommendedLayerHeight;
        // Orca slices each layer at its mid-height; the first relief layer is the first whose middle is above the boundary.
        const layerIdx = boundary + lh / 2 <= FIRST_LAYER ? 1 : Math.ceil((boundary + lh / 2 - FIRST_LAYER) / lh - 1e-9) + 1;
        colorChanges.push({
          zMm: Math.round(boundary * 100) / 100,
          layerIdx, // 1-indexed: pause/swap before this layer
          layerTopMm: Math.round((FIRST_LAYER + (layerIdx - 1) * lh) * 100) / 100, // the Z Orca lists for that layer
          prevAreaMm2: Math.round(prevArea),
          newAreaMm2: Math.round(curArea),
          dropPct: Math.round((1 - curArea / prevArea) * 100),
        });
      }
    }
  }

  return {
    isRelief,
    hasThinFeatures,
    reliefTooFine,
    recommendedLayerHeight,
    wallGenerator,
    needsSupport,
    goodContact,
    colorChange: colorChanges[0] ?? null,
    colorChanges,
  };
}

export function generateOrcaPreset(profileName, printerId, traits) {
  const isAD5M = printerId === "ad5m";
  const isP1S = printerId === "p1s";

  const inherits = isAD5M
    ? (traits.recommendedLayerHeight <= 0.12 ? "0.12mm Fine @Flashforge AD5M Pro 0.4 Nozzle" : "0.20mm Standard @Flashforge AD5M Pro 0.4 Nozzle")
    : (traits.recommendedLayerHeight <= 0.12 ? "0.12mm Fine @BBL X1C" : "0.20mm Standard @BBL X1C");

  const compatible = isAD5M
    ? ["Flashforge Adventurer 5M Pro 0.4 Nozzle", "Flashforge Adventurer 5M 0.4 Nozzle"]
    : (isP1S ? ["Bambu Lab P1S 0.4 nozzle", "Bambu Lab X1 Carbon 0.4 nozzle", "Bambu Lab A1 0.4 nozzle", "Bambu Lab A1 mini 0.4 nozzle"] : []);

  return {
    type: "process",
    name: profileName || (traits.isRelief ? "0.12mm Fine Relief Profile" : "Optimized Process Profile"),
    inherits: inherits,
    from: "User",
    instantiation: "true",
    compatible_printers: compatible,
    layer_height: String(traits.recommendedLayerHeight),
    initial_layer_print_height: FIRST_LAYER.toFixed(2),
    wall_generator: traits.wallGenerator,
    detect_thin_wall: "1",
    // Narrow raised strokes print as two walls with a strip between; without gap fill that strip stays
    // empty and, on a two-colour print, the base colour shows through as a line down each stroke.
    gap_fill_target: "everywhere",
    filter_out_gap_fill: "0",
    min_feature_size: "25%",
    min_bead_width: "85%",
    line_width: "0.42",
    outer_wall_line_width: "0.38",
    inner_wall_line_width: "0.42",
    top_surface_line_width: "0.36",
    top_surface_pattern: "monotonicline",
    top_shell_layers: traits.recommendedLayerHeight <= 0.12 ? "5" : "4",
    bottom_shell_layers: "4",
    sparse_infill_density: "15%",
    sparse_infill_pattern: "gyroid",
    enable_support: traits.needsSupport ? "1" : "0",
    brim_type: traits.goodContact ? "no_brim" : "auto_brim",
    skirt_loops: "0",
    top_surface_speed: traits.isRelief ? "60" : "150",
    outer_wall_speed: traits.isRelief ? "70" : "200",
  };
}
