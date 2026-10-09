'use client';

import { type RowComponentProps } from "react-window";
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { SerialMessage } from "../types/SerialMessage";
import { type LineNumbers } from "./SerialTerminal";

const SELECTED_ROW_BACKGROUND = 'rgba(255,255,255,0.12)';

export default function RowComponent({
  index,
  serialMessages,
  style,
  onClickRow,
  selectedLineId,
  lineNumbers,
}: RowComponentProps<{
  serialMessages: SerialMessage[];
  onClickRow?: (message_id: number) => void;
  selectedLineId?: number | null;
  lineNumbers?: LineNumbers;
}>) {
  const line = serialMessages[index];
  const isSelected = selectedLineId === line.id;
  return (
    <div
      className="serial-terminal-row"
      // Rows as wide as their content so the sticky line number stays visible on long lines
      style={{ ...style, width: 'max-content', minWidth: '100%', whiteSpace: 'pre', backgroundColor: isSelected ? SELECTED_ROW_BACKGROUND : undefined, cursor: 'pointer' }}
      onClick={onClickRow ? (e) => {
        if (window.getSelection()?.toString()) return;
        onClickRow(line.id);
      } : undefined}
    >
      {lineNumbers && (
        <Box
          component="span"
          aria-hidden
          data-line-number={lineNumbers.numberOf(index) ?? ''}
          sx={{
            position: 'sticky',
            left: 0,
            display: 'inline-block',
            width: `${lineNumbers.digits + 2}ch`,
            pr: '1ch',
            textAlign: 'right',
            fontFamily: 'monospace',
            fontSize: '0.875rem',
            lineHeight: 1.2,
            color: '#545a62',
            userSelect: 'none',
            // Opaque so text scrolled horizontally passes under it, matching the row selection
            background: isSelected
              ? `linear-gradient(${SELECTED_ROW_BACKGROUND}, ${SELECTED_ROW_BACKGROUND}), #1e1e1e`
              : '#1e1e1e',
            // Generated content is neither selectable nor part of the copied text
            '&::before': { content: 'attr(data-line-number)' },
          }}
        />
      )}
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