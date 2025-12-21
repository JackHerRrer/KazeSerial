'use client';

import { type RowComponentProps } from "react-window";
import Typography from '@mui/material/Typography';

export default function RowComponent({
  index,
  names,
  style
}: RowComponentProps<{
  names: string[];
}>) {
  const line = names[index];
  return (
    <div style={{ ...style, whiteSpace: 'pre-wrap' }}>
      <Typography
        component="span"
        sx={{
          fontFamily: 'monospace',
          fontSize: '0.875rem',
          color: '#d4d4d4',
          lineHeight: 1.2,
        }}
        dangerouslySetInnerHTML={{ __html: line }}
      >
      </Typography>
    </div>
  );

}