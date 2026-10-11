'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Popover from '@mui/material/Popover';
import Sketch from '@uiw/react-color-sketch';

// Color palette matching the screenshot (8 columns × 4 rows, light → dark)
const PRESET_COLORS = [
  '#99c1f1', '#8ff0a4', '#f9f06b', '#ffbe6f', '#f66151', '#dc8add', '#cdab8f', '#ffffff',
  '#62a0ea', '#57e389', '#f8e45c', '#ffa348', '#ed333b', '#c061cb', '#b5835a', '#deddda',
  '#3584e4', '#33d17a', '#f6d32d', '#ff7800', '#e01b24', '#9141ac', '#986a44', '#9a9996',
  '#1c71d8', '#26a269', '#f5c211', '#e66100', '#c01c28', '#813d9c', '#856e3c', '#5e5c64',
  '#1a5fb4', '#25a168', '#e5a50a', '#c54500', '#a51d2d', '#613583', '#63452c', '#241f31',

];

interface ColorPickerButtonProps {
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
  opacity?: number;
  // Adds an alpha slider; the color is then returned as #rrggbbaa
  alpha?: boolean;
}

const ColorPickerButton: React.FC<ColorPickerButtonProps> = ({ value, onChange, disabled, opacity, alpha }) => {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  return (
    <>
      <Box
        component="button"
        onClick={disabled ? undefined : (e: React.MouseEvent<HTMLElement>) => setAnchorEl(e.currentTarget)}
        sx={{
          width: 26,
          height: 26,
          backgroundColor: value,
          border: '2px solid rgba(255,255,255,0.25)',
          borderRadius: '3px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: opacity ?? 1,
          padding: 0,
          flexShrink: 0,
          '&:hover': disabled ? {} : { borderColor: 'rgba(255,255,255,0.6)' },
        }}
      />
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        <Sketch
          color={value}
          presetColors={PRESET_COLORS}
          disableAlpha={!alpha}
          onChange={(color) => onChange(alpha ? color.hexa : color.hex)}
          style={{
            '--sketch-background': '#2b2b2b',
            '--sketch-box-shadow': 'none',
            '--sketch-swatch-border-top': '1px solid #444',
            '--sketch-swatch-box-shadow': 'rgb(0 0 0 / 40%) 0px 0px 0px 1px inset',
            '--sketch-alpha-box-shadow': 'rgb(0 0 0 / 40%) 0px 0px 0px 1px inset',
            '--editable-input-color': '#fff',
            '--editable-input-label-color': '#aaa',
            '--editable-input-box-shadow': '0 0 0 1px #555 inset',
          } as React.CSSProperties}
        />
      </Popover>
    </>
  );
};

export default ColorPickerButton;
