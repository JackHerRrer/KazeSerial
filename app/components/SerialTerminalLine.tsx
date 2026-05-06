'use client';

import { type RowComponentProps } from "react-window";
import Typography from '@mui/material/Typography';
import { SerialMessage } from "../types/SerialMessage";

export default function RowComponent({
  index,
  serialMessages,
  style,
  onClickRow,
  selectedLineId,
}: RowComponentProps<{
  serialMessages: SerialMessage[];
  onClickRow?: (message_id: number) => void;
  selectedLineId?: number | null;
}>) {
  const line = serialMessages[index];
  const isSelected = selectedLineId === line.id;
  return (
    <div
      style={{ ...style, whiteSpace: 'pre', backgroundColor: isSelected ? 'rgba(255,255,255,0.12)' : undefined, cursor: 'pointer' }}
      onClick={onClickRow ? (e) => {
        if (window.getSelection()?.toString()) return;
        onClickRow(line.id);
      } : undefined}
    >
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