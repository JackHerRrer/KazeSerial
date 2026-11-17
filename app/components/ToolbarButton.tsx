'use client';

import React from 'react';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

interface ToolbarButtonProps {
  title: string;
  label: string;
  // Toggle state of a toggle button, highlighted in blue while on; omitted for other buttons
  active?: boolean;
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
  children: React.ReactNode;
}

/** Icon button of the toolbars over the terminals */
const ToolbarButton: React.FC<ToolbarButtonProps> = ({ title, label, active, onClick, children }) => (
  <Tooltip title={title} placement="top" arrow>
    <IconButton
      aria-label={label}
      aria-pressed={active}
      size="medium"
      color="inherit"
      onClick={onClick}
      sx={{
        width: 36,
        height: 36,
        border: '1px solid #333',
        bgcolor: active ? 'rgba(33, 150, 243, 0.28)' : 'rgba(30, 30, 30, 0.75)',
        '&:hover': {
          bgcolor: active ? 'rgba(33, 150, 243, 0.42)' : 'rgba(30, 30, 30, 0.95)',
        },
      }}
    >
      {children}
    </IconButton>
  </Tooltip>
);

export default ToolbarButton;
