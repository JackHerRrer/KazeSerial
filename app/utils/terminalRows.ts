import type { SerialMessage } from '../types/SerialMessage';

/**
 * Rows of a terminal and its minimap: the lines of the log except those hidden by a remove rule.
 * Kept as the indices of the hidden lines, usually none, so lines appended to the log only need
 * their own scan. The fields are private: in development, React compares the old and new props of
 * every rendered component property by property, which would go through the whole log for each row.
 */
export class TerminalRows {
  static readonly EMPTY = new TerminalRows([], []);

  readonly #lines: SerialMessage[];
  // Indices of the hidden lines, in increasing order
  readonly #hidden: number[];

  private constructor(lines: SerialMessage[], hidden: number[]) {
    this.#lines = lines;
    this.#hidden = hidden;
  }

  /** Rows of `lines`. When `lines` appends to the lines of these rows, only the new lines are scanned. */
  update(lines: SerialMessage[]): TerminalRows {
    if (lines === this.#lines) return this;
    const known = this.#lines.length;
    // Inserting or replacing lines changes the line at the last known position, appending does not
    const isAppend = known > 0 && lines.length >= known && lines[known - 1] === this.#lines[known - 1];
    const newHidden: number[] = [];
    for (let index = isAppend ? known : 0; index < lines.length; index++) {
      if (lines[index].removed_line) newHidden.push(index);
    }
    const hidden = !isAppend ? newHidden : newHidden.length > 0 ? this.#hidden.concat(newHidden) : this.#hidden;
    return new TerminalRows(lines, hidden);
  }

  /** All the lines, hidden ones included */
  get lines(): SerialMessage[] {
    return this.#lines;
  }

  get count(): number {
    return this.#lines.length - this.#hidden.length;
  }

  /** Line index of each row from `first` to `last` */
  lineIndices(first: number, last: number): number[] {
    const hidden = this.#hidden;
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
  }

  /** Line index of row `row` */
  lineOf(row: number): number {
    return this.lineIndices(row, row)[0];
  }

  /** Row of the line at `index`; for a hidden line, the row of the next shown line, or the last row */
  rowOf(index: number): number {
    const hidden = this.#hidden;
    // Hidden lines before `index`
    let low = 0;
    let high = hidden.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (hidden[middle] < index) low = middle + 1;
      else high = middle;
    }
    return Math.min(index - low, this.count - 1);
  }
}
