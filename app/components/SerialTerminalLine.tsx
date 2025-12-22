'use client';

import { type RowComponentProps } from "react-window";
import Typography from '@mui/material/Typography';
import { SerialMessage } from "../types/SerialMessage";

export default function RowComponent({
  index,
  serialMessages,
  style,
  onClickRow,
}: RowComponentProps<{
  serialMessages: SerialMessage[];
  onClickRow?: (message_id: number) => void;
}>) {
  const line = serialMessages[index];
  return (
    <div
      style={{ ...style, whiteSpace: 'pre' }}
      onClick={onClickRow ? () => onClickRow(line.id) : undefined}
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