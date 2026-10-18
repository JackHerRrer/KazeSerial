import type { SerialMessage } from '../types/SerialMessage';

/**
 * Rows of the minimap: the lines of the log except those hidden by a remove rule, which have no
 * height in the terminal. Kept as the indices of the hidden lines, usually none, so lines appended
 * to the log only need their own scan.
 */
export type MinimapRows = {
  lines: SerialMessage[];
  // Indices of the hidden lines, in increasing order
  hidden: number[];
};

export const NO_ROWS: MinimapRows = { lines: [], hidden: [] };

/** Rows of `lines`. When `lines` appends to the lines of `previous`, only the new lines are scanned. */
export const minimapRows = (lines: SerialMessage[], previous: MinimapRows): MinimapRows => {
  if (lines === previous.lines) return previous;
  const known = previous.lines.length;
  // Inserting or replacing lines changes the line at the last known position, appending does not
  const isAppend = known > 0 && lines.length >= known && lines[known - 1] === previous.lines[known - 1];
  const newHidden: number[] = [];
  for (let index = isAppend ? known : 0; index < lines.length; index++) {
    if (lines[index].removed_line) newHidden.push(index);
  }
  const hidden = !isAppend ? newHidden : newHidden.length > 0 ? previous.hidden.concat(newHidden) : previous.hidden;
  return { lines, hidden };
};

export const rowCount = ({ lines, hidden }: MinimapRows): number => lines.length - hidden.length;

/** Line index of each row from `first` to `last` */
export const rowLines = ({ hidden }: MinimapRows, first: number, last: number): number[] => {
  // Hidden lines before the line of row `first`: those with at most `first` rows before them
  let low = 0;
  let high = hidden.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (hidden[middle] - middle <= first) low = middle + 1;
    else high = middle;
  }
  const indices: number[] = [];
  let next = low;
  for (let row = first, index = first + low; row <= last; row++, index++) {
    while (next < hidden.length && hidden[next] === index) {
      next++;
      index++;
    }
    indices.push(index);
  }
  return indices;
};
