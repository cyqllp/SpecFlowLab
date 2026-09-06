export const ORIGIN_CLASSIC_COMPONENT_COLORS = Object.freeze([
  "#000000", // black
  "#ff0000", // red
  "#008000", // green
  "#0000ff", // blue
  "#00bfc4", // cyan, darkened slightly for a white plotting surface
  "#ff00ff", // magenta
  "#b5a000", // yellow, darkened for legibility
  "#000080", // navy
  "#800080", // purple
  "#800000", // wine
  "#808000", // olive
  "#008080", // dark cyan
]);

export function componentColor(index) {
  const safeIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  return ORIGIN_CLASSIC_COMPONENT_COLORS[safeIndex % ORIGIN_CLASSIC_COMPONENT_COLORS.length];
}
