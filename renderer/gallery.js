// Shared, side-effect-free rules used by the build, layout and automated checks.
export const coverRatios = ["16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"];
export const ratioValue = (ratio) =>
  ratio.split(":").reduce((width, height) => width / Number(height));
export function selectCoverRatio(width, height, requested = "auto") {
  if (requested !== "auto") {
    if (!coverRatios.includes(requested))
      throw new Error(`Unsupported coverRatio: ${requested}`);
    return requested;
  }
  const source = width > 0 && height > 0 ? width / height : 1;
  return coverRatios.reduce(
    (best, candidate) =>
      Math.abs(Math.log(ratioValue(candidate) / source)) <
      Math.abs(Math.log(ratioValue(best) / source))
        ? candidate
        : best,
    coverRatios[0],
  );
}
export function adjacentProjects(projects, currentId) {
  const index = projects.findIndex((project) => project.id === currentId);
  if (index < 0) return [];
  const used = new Set([currentId]);
  const results = [];
  for (const offset of [-2, -1, 1, 2, ...projects.map((_, i) => i + 3)]) {
    const item =
      projects[
        (((index + offset) % projects.length) + projects.length) %
          projects.length
      ];
    if (!used.has(item.id)) {
      used.add(item.id);
      results.push(item);
    }
    if (results.length === Math.min(4, projects.length - 1)) break;
  }
  return results;
}
export function masonryLayout(ratios, width, columns, gap) {
  const cardWidth = (width - gap * (columns - 1)) / columns;
  const heights = Array(columns).fill(0);
  const positions = ratios.map((ratio) => {
    const column = heights.indexOf(Math.min(...heights));
    const result = {
      x: column * (cardWidth + gap),
      y: heights[column],
      width: cardWidth,
      height: cardWidth / ratioValue(ratio),
    };
    heights[column] += result.height + gap;
    return result;
  });
  return {
    positions,
    height: positions.length ? Math.max(...heights) - gap : 0,
  };
}
