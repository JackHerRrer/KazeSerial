'use client';

import { useLayoutEffect, useRef } from "react";
import { type RowComponentProps } from "react-window";
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { SerialMessage } from "../types/SerialMessage";
import { type Arrival, type LineNumbers, type RowSearch, type Timestamps } from "./SerialTerminal";
import { domRanges, highlightNamed, lineRanges } from "../utils/search";
import { formatTimestamp, isTimestampShown, timestampColumnText } from "../utils/timestamp";

const SELECTED_ROW_BACKGROUND = 'rgba(255,255,255,0.12)';
// Marker lines: text color, and a light tint of it as row background
export const MARKER_COLOR = '#c586c0';
const MARKER_BACKGROUND = 'rgba(197,134,192,0.12)';

export default function RowComponent({
  index,
  serialMessages,
  style,
  onClickRow,
  selectedLineId,
  lineNumbers,
  timestamps,
  arrival,
  search,
}: RowComponentProps<{
  serialMessages: SerialMessage[];
  onClickRow?: (message_id: number) => void;
  selectedLineId?: number | null;
  lineNumbers?: LineNumbers;
  timestamps?: Timestamps;
  arrival?: Arrival;
  search?: RowSearch;
}>) {
  const line = serialMessages[index];
  const rowRef = useRef<HTMLDivElement>(null);
  const arrivalMs = arrival?.durationMs;
  const arrivalColor = arrival?.color;

  // New line highlight. Rows are only rendered while visible, so the fade is computed from the
  // line arrival time: a negative delay resumes it where it is when the row is (re)mounted.
  // The tint is an inset shadow, so it never hides the selection background.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || arrivalMs === undefined || arrivalColor === undefined || line.arrivedAt === undefined) return;
    const elapsed = Date.now() - line.arrivedAt;
    if (elapsed >= arrivalMs) return;
    const animation = row.animate(
      [
        { boxShadow: `inset 0 0 0 100vmax ${arrivalColor}` },
        { boxShadow: 'inset 0 0 0 100vmax transparent' },
      ],
      { duration: arrivalMs, delay: -elapsed, easing: 'ease-out' },
    );
    return () => animation.cancel();
  }, [arrivalMs, arrivalColor, line.arrivedAt]);

  // Search matches, painted with the CSS Custom Highlight API so the line HTML is left untouched.
  // Ranges are cached per line, so they keep their identity until the line or the search changes.
  const contentRef = useRef<HTMLSpanElement>(null);
  const searchRanges = search && !line.removed_line ? lineRanges(line, search.regex) : undefined;
  const currentOccurrence = search?.current?.line === index ? search.current.occurrence : -1;
  useLayoutEffect(() => {
    const content = contentRef.current;
    const matchHighlight = highlightNamed('search-match');
    const currentHighlight = highlightNamed('search-current', 1);
    if (!content || !searchRanges?.length || !matchHighlight || !currentHighlight) return;
    const added = domRanges(content, searchRanges).flatMap((range, occurrence) => {
      if (!range) return [];
      const highlight = occurrence === currentOccurrence ? currentHighlight : matchHighlight;
      highlight.add(range);
      return [{ highlight, range }];
    });
    return () => added.forEach(({ highlight, range }) => highlight.delete(range));
  }, [searchRanges, currentOccurrence]);
  const isSelected = selectedLineId === line.id;
  const timestamp = timestamps && line.timestamp != null && isTimestampShown(serialMessages, index, timestamps.inactivityMs)
    ? formatTimestamp(line.timestamp, timestamps.format)
    : '';
  // Shared by the gutter boxes, sticky on the left so text scrolled horizontally passes under them
  const gutterSx = {
    position: 'sticky',
    display: 'inline-block',
    fontFamily: 'monospace',
    fontSize: '0.875rem',
    lineHeight: 1.2,
    color: '#545a62',
    // Opaque, matching the row selection
    background: isSelected
      ? `linear-gradient(${SELECTED_ROW_BACKGROUND}, ${SELECTED_ROW_BACKGROUND}), #1e1e1e`
      : '#1e1e1e',
  } as const;
  const timestampLeft = lineNumbers ? `${lineNumbers.digits + 2}ch` : 0;
  return (
    <div
      ref={rowRef}
      className="serial-terminal-row"
      data-line-id={line.id}
      // Rows as wide as their content so the sticky gutter stays visible on long lines
      style={{ ...style, width: 'max-content', minWidth: '100%', whiteSpace: 'pre', backgroundColor: isSelected ? SELECTED_ROW_BACKGROUND : line.marker ? MARKER_BACKGROUND : undefined, cursor: 'pointer' }}
      onClick={onClickRow ? () => {
        if (window.getSelection()?.toString()) return;
        onClickRow(line.id);
      } : undefined}
    >
      {/* Number and timestamp are separate sticky boxes: WebKit fills the selection gap
          before selected text up to the start of its box, which would cover the number if
          a selectable timestamp shared its box */}
      {lineNumbers && (
        <Box
          component="span"
          aria-hidden
          data-line-number={lineNumbers.numberOf(index) ?? ''}
          sx={{
            ...gutterSx,
            left: 0,
            width: `${lineNumbers.digits + 2}ch`,
            pr: '1ch',
            textAlign: 'right',
            userSelect: 'none',
            // Generated content is neither selectable nor part of the copied text
            '&::before': { content: 'attr(data-line-number)' },
          }}
        />
      )}
      {timestamps && (timestamps.inText ? (
        // Real text, so it is selectable and copied
        <Box component="span" sx={{ ...gutterSx, left: timestampLeft, width: `${timestamps.width + 1}ch` }}>
          {timestampColumnText(timestamp, timestamps.width)}
        </Box>
      ) : (
        <Box
          component="span"
          aria-hidden
          data-timestamp={timestamp}
          sx={{
            ...gutterSx,
            left: timestampLeft,
            width: `${timestamps.width + 1}ch`,
            userSelect: 'none',
            '&::before': { content: 'attr(data-timestamp)' },
          }}
        />
      ))}
      <Typography
        ref={contentRef}
        component="span"
        sx={{
          fontFamily: 'monospace',
          fontSize: '0.875rem',
          color: line.marker ? MARKER_COLOR : '#d4d4d4',
          fontWeight: line.marker ? 'bold' : undefined,
          lineHeight: 1.2,
        }}
        dangerouslySetInnerHTML={{ __html: line.message }}
      >
      </Typography>
    </div>
  );

}