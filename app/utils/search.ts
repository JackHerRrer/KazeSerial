import type { SerialMessage } from '../types/SerialMessage';

export type SearchOptions = {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
};

/** A match: the `occurrence`-th match of line `line` */
export type SearchMatch = {
  line: number;
  occurrence: number;
};

/** Builds the search regex, or null when the query is empty or an invalid regex */
export const buildSearchRegex = ({ query, caseSensitive, regex }: SearchOptions): RegExp | null => {
  if (query === '') return null;
  const pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(pattern, caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
};

const displayTextCache = new WeakMap<SerialMessage, string>();

/**
 * Text of a line as displayed: its HTML message without the highlight tags, unescaped. The backend
 * only emits `<span>` tags and escapes `&`, `<`, `>` and `"` in the text, so this is exact.
 */
export const displayText = (line: SerialMessage): string => {
  let text = displayTextCache.get(line);
  if (text === undefined) {
    text = line.message
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    displayTextCache.set(line, text);
  }
  return text;
};

const rangesCache = new WeakMap<SerialMessage, { key: string; ranges: [number, number][] }>();

/**
 * Character ranges `[start, end)` of the matches of `regex` in the displayed text of `line`.
 * Cached per line and regex, so rescanning a growing log only scans the new lines, and the
 * returned array keeps its identity.
 */
export const lineRanges = (line: SerialMessage, regex: RegExp): [number, number][] => {
  const key = `${regex.flags}/${regex.source}`;
  const cached = rangesCache.get(line);
  if (cached?.key === key) return cached.ranges;

  const ranges: [number, number][] = [];
  const text = displayText(line);
  regex.lastIndex = 0;
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    if (match[0].length === 0) {
      // Empty matches (e.g. `a*`) are skipped
      regex.lastIndex++;
      continue;
    }
    ranges.push([match.index, match.index + match[0].length]);
  }
  rangesCache.set(line, { key, ranges });
  return ranges;
};

/** All matches of `regex` in `lines`, in order; lines hidden by a remove rule are skipped */
export const findMatches = (lines: SerialMessage[], regex: RegExp): SearchMatch[] => {
  const matches: SearchMatch[] = [];
  lines.forEach((line, index) => {
    if (line.removed_line) return;
    lineRanges(line, regex).forEach((_, occurrence) => matches.push({ line: index, occurrence }));
  });
  return matches;
};

// Styles of the search highlights, the current match more visible. Injected at runtime because the
// build CSS parser does not know the ::highlight() pseudo-element yet (it is supported by WebKit).
const HIGHLIGHT_STYLES = `
::highlight(search-match) { background-color: rgba(230, 190, 60, 0.35); }
::highlight(search-current) { background-color: rgba(255, 140, 0, 0.9); color: #1e1e1e; }
`;

/** Shared CSS Custom Highlight, created on first use; undefined when the API is not supported */
export const highlightNamed = (name: string, priority = 0): Highlight | undefined => {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return undefined;
  if (!document.getElementById('search-highlight-styles')) {
    const style = document.createElement('style');
    style.id = 'search-highlight-styles';
    style.textContent = HIGHLIGHT_STYLES;
    document.head.appendChild(style);
  }
  let highlight = CSS.highlights.get(name);
  if (!highlight) {
    highlight = new Highlight();
    highlight.priority = priority;
    CSS.highlights.set(name, highlight);
  }
  return highlight;
};

/** DOM range covering each character range of the text inside `element`, null if out of the text */
export const domRanges = (element: HTMLElement, ranges: [number, number][]): (Range | null)[] => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let length = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    nodes.push({ node, start: length });
    length += node.length;
  }
  // Text node and offset holding the character at `position`
  const locate = (position: number, isEnd: boolean) => {
    const found = nodes.find(({ node, start }) =>
      isEnd ? position > start && position <= start + node.length : position >= start && position < start + node.length);
    return found ? { node: found.node, offset: position - found.start } : undefined;
  };
  return ranges.map(([start, end]) => {
    const from = locate(start, false);
    const to = locate(end, true);
    if (!from || !to) return null;
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  });
};
