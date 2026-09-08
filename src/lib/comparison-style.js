import { componentColor } from "./component-colors.js";

export function comparisonStyleDefaults(index, label) {
  return {
    color: componentColor(index),
    label,
    lineStyle: "solid",
    lineWidth: 2.2,
  };
}
