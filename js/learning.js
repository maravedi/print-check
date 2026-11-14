// Questions are guidance tied to findings, not proof of printability.
export const QUESTIONS = {
  floating: {
    question: "What should hold up a piece that is floating above the bed?",
    choices: ["Another part that overlaps it, or the print bed", "Empty space beneath it", "A different file name"],
    hint: "A printer builds each layer on something below it.",
    explanation: "Move the piece onto the bed or overlap it with a supporting part. Group, export and check again.",
  },
  empty_layers: {
    question: "What can connect the upper and lower parts across an empty layer?",
    choices: ["Move the upper part down until it overlaps the lower part", "Rename the file", "Change the model color"],
    hint: "Look for the gap between the two parts.",
    explanation: "Overlap the pieces so the printer has material to build on, then group and export again.",
  },
  thin: {
    question: "What could happen to a very thin wall or small detail?",
    choices: ["It could be weak or missing", "It always becomes stronger", "It changes the printer's bed size"],
    hint: "Compare the feature's thickness with the width of an extrusion.",
    explanation: "Make important thin areas thicker and check the new export; small details may still need teacher review.",
  },
  overhang: {
    question: "Why might a steep overhang need supports?",
    choices: ["Its underside may have little material beneath it", "The STL has a long name", "It makes the bed larger"],
    hint: "Think about what the printer builds each layer on.",
    explanation: "Supports can hold up steep areas but add time and leave marks. A different shape or orientation may reduce them.",
  },
  fit: {
    question: "What can you check if the model is too large for both printers?",
    choices: ["Its dimensions and whether a smaller size still works", "The file name's length", "The color of the workplane"],
    hint: "Compare the model's measurements with the available print area.",
    explanation: "A proportional reduction may help, but check useful size, holes and fine details, then export and check again.",
  },
  time: {
    question: "What is a useful first step when the estimated print time is high?",
    choices: ["Consider reducing height or simplifying the design", "Assume the estimate is the exact print time", "Rename the STL"],
    hint: "Think about how much material and how many layers must be printed.",
    explanation: "Smaller or simpler designs can print faster. Keep the design useful and ask your teacher to confirm the final time.",
  },
};

export function questionFor(item) {
  return (item.status === "fail" || item.status === "warn") ? QUESTIONS[item.id] || null : null;
}

export function compareChecks(previous, current) {
  if (!previous) return null;
  const previousIssues = previous.results.filter(r => r.status === "fail" || r.status === "warn");
  const fixed = previousIssues.filter(old => current.results.some(now => now.id === old.id && now.status === "pass"));
  const remaining = previousIssues.filter(old => current.results.some(now => now.id === old.id && (now.status === "fail" || now.status === "warn")));
  return { fixed, remaining };
}
