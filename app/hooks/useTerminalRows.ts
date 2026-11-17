'use client';

import { useState } from 'react';
import { SerialMessage } from '../types/SerialMessage';
import { TerminalRows } from '../utils/terminalRows';

/** Rows of a terminal showing `lines`. The rows of the previous lines are kept, so a new line only scans itself. */
export function useTerminalRows(lines: SerialMessage[]): TerminalRows {
  const [previousRows, setPreviousRows] = useState(TerminalRows.EMPTY);
  const rows = previousRows.update(lines);
  if (rows !== previousRows) setPreviousRows(rows);
  return rows;
}
