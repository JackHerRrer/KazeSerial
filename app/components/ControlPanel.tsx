'use client';

import React from 'react';
import Box from '@mui/material/Box';
import SerialSettings from './SerialSettings';
import HighLighSettings from './HighLighSettings';

const ControlPanel: React.FC = () => {
  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ p: 3, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <SerialSettings />
      </Box>
      <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0, p: 3 }}>
        <HighLighSettings />
      </Box>
    </Box>
  );
};

export default ControlPanel;

