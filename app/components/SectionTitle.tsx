'use client';

import React from 'react';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';

/** Small title of a group of settings */
const SectionTitle: React.FC<{ children: React.ReactNode; sx?: SxProps<Theme> }> = ({ children, sx }) => (
  <Typography variant="overline" component="h3" sx={{ display: 'block', color: 'text.secondary', fontWeight: 600, lineHeight: 2, ...sx }}>
    {children}
  </Typography>
);

export default SectionTitle;
