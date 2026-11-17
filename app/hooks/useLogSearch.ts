'use client';

import { useCallback, useMemo, useState } from 'react';
import { SerialMessage } from '../types/SerialMessage';
import { buildSearchRegex, findMatches, SearchMatch, SearchOptions } from '../utils/search';

export type LogSearch = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  options: SearchOptions;
  setOptions: (options: SearchOptions) => void;
  regex: RegExp | null;
  matches: SearchMatch[];
  currentIndex: number; // -1 when there is no match
  next: () => void;
  previous: () => void;
};

/**
 * Search in `lines`. `reveal` scrolls to a line: called on the first match when the search changes,
 * and on each match reached with next / previous.
 */
export function useLogSearch(lines: SerialMessage[], reveal: (line: number) => void): LogSearch {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptionsState] = useState<SearchOptions>({ query: '', caseSensitive: false, regex: false });
  const [current, setCurrent] = useState(0);

  const regex = useMemo(() => buildSearchRegex(options), [options]);
  const matches = useMemo(() => (isOpen && regex ? findMatches(lines, regex) : []), [isOpen, lines, regex]);
  // Lines can disappear (Clear, Refresh), so the current match is clamped
  const currentIndex = matches.length > 0 ? Math.min(current, matches.length - 1) : -1;

  const goTo = (index: number) => {
    setCurrent(index);
    reveal(matches[index].line);
  };

  const setOptions = (newOptions: SearchOptions) => {
    setOptionsState(newOptions);
    setCurrent(0);
    const newRegex = buildSearchRegex(newOptions);
    const newMatches = newRegex ? findMatches(lines, newRegex) : [];
    if (newMatches.length > 0) reveal(newMatches[0].line);
  };

  // Stable, so a keyboard shortcut effect can use it
  const open = useCallback(() => setIsOpen(true), []);

  return {
    isOpen,
    open,
    close: () => setIsOpen(false),
    options,
    setOptions,
    regex,
    matches,
    currentIndex,
    next: () => {
      if (matches.length > 0) goTo((currentIndex + 1) % matches.length);
    },
    previous: () => {
      if (matches.length > 0) goTo((currentIndex - 1 + matches.length) % matches.length);
    },
  };
}
