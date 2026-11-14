// Printer profiles (PLA, 0.4 mm nozzle, 0.20 mm layers), taken from OrcaSlicer's
// system profiles by tools/orca_profiles.py. Speeds in mm/s, sizes in mm.
// `fit` is the calibration of slicer.js against OrcaSlicer (tools/fit_estimator.mjs).

export const PRINTERS = {
  p1s: {
    id: "p1s",
    name: "Bambu Lab P1S / P1P",
    bed: [256, 256, 250],
    layer: 0.2, firstLayer: 0.2, walls: 2, top: 5, bottom: 3, infill: 0.15,
    lw: { outer: 0.42, inner: 0.45, infill: 0.45, solid: 0.42, top: 0.42, support: 0.42 },
    speed: { outer: 200, inner: 300, infill: 270, solid: 250, top: 200, support: 150, bridge: 50,
             first: 50, firstInfill: 105, travel: 500 },
    accel: 10000, maxVolumetric: 21, minLayerTime: 4, slowMin: 20,
    supportAngle: 30,
    startupMin: 6, // calibration + heating before the model starts (not counted by default)
    fit: { wall: 4.0067, infill: 1.6937, support: 1.1118, corner: 0.1264, travel: 1.7269, cool: 0.144, layerOverhead: 3.2868 },
  },
  ad5m: {
    id: "ad5m",
    name: "Flashforge Adventurer 5M",
    bed: [220, 220, 220],
    layer: 0.2, firstLayer: 0.2, walls: 2, top: 5, bottom: 3, infill: 0.15,
    lw: { outer: 0.42, inner: 0.45, infill: 0.45, solid: 0.42, top: 0.42, support: 0.42 },
    speed: { outer: 200, inner: 300, infill: 270, solid: 250, top: 200, support: 150, bridge: 25,
             first: 50, firstInfill: 80, travel: 500 },
    accel: 10000, maxVolumetric: 25, minLayerTime: 6, slowMin: 20,
    supportAngle: 30,
    startupMin: 3,
    fit: { wall: 4.4308, infill: 1.7023, support: 3.3758, corner: 0.0851, travel: 1.7454, cool: 0.1009, layerOverhead: 3.5992 },
  },
};
