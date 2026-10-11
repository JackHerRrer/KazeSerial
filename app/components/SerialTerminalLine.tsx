'use client';

import { type RowComponentProps } from "react-window";
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { SerialMessage } from "../types/SerialMessage";
import { type LineNumbers, type Timestamps } from "./SerialTerminal";
import { formatTimestamp, isTimestampShown, timestampColumnText } from "../utils/timestamp";

const SELECTED_ROW_BACKGROUND = 'rgba(255,255,255,0.12)';

export default function RowComponent({
  index,
  serialMessages,
  style,
  onClickRow,
  selectedLineId,
  lineNumbers,
  timestamps,
}: RowComponentProps<{
  serialMessages: SerialMessage[];
  onClickRow?: (message_id: number) => void;
  selectedLineId?: number | null;
  lineNumbers?: LineNumbers;
  timestamps?: Timestamps;
}>) {
  const line = serialMessages[index];
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
      className="serial-terminal-row"
      // Rows as wide as their content so the sticky gutter stays visible on long lines
      style={{ ...style, width: 'max-content', minWidth: '100%', whiteSpace: 'pre', backgroundColor: isSelected ? SELECTED_ROW_BACKGROUND : undefined, cursor: 'pointer' }}
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
        component="span"
        sx={{
          fontFamily: 'monospace',
          fontSize: '0.875rem',
          color: '#d4d4d4',
          lineHeight: 1.2,
        }}
        dangerouslySetInnerHTML={{ __html: line.message }}
      >
      </Typography>
    </div>
  );

}