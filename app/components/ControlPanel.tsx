'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import SerialSettings from './SerialSettings';
import HighLighSettings from './HighLighSettings';

type SourceTab = 'serial' | 'file';
type BottomTab = 'highlight' | 'config';

// Panels stay mounted when inactive so their internal state (connection, rules...) is preserved
const TabPanel: React.FC<{ active: boolean; children?: React.ReactNode; sx?: object }> = ({ active, children, sx }) => (
  <Box role="tabpanel" hidden={!active} sx={{ display: active ? 'block' : 'none', ...sx }}>
    {children}
  </Box>
);

const SourcePanel: React.FC<{ active: boolean; children?: React.ReactNode }> = ({ active, children }) => (
  <Box
    role="tabpanel"
    aria-hidden={!active}
    sx={{ gridArea: '1 / 1', p: 3, minWidth: 0, visibility: active ? 'visible' : 'hidden' }}
  >
    {children}
  </Box>
);

const ControlPanel: React.FC = () => {
  const [sourceTab, setSourceTab] = useState<SourceTab>('serial');
  const [bottomTab, setBottomTab] = useState<BottomTab>('highlight');

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <Tabs
          value={sourceTab}
          onChange={(_, value: SourceTab) => setSourceTab(value)}
          variant="fullWidth"
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab label="Serial" value="serial" />
          <Tab label="File" value="file" />
        </Tabs>
        {/* Source panels are stacked in the same grid cell so the area keeps the height of the tallest one */}
        <Box sx={{ display: 'grid' }}>
          <SourcePanel active={sourceTab === 'serial'}>
            <SerialSettings />
          </SourcePanel>
          <SourcePanel active={sourceTab === 'file'} />
        </Box>
      </Box>
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Tabs
          value={bottomTab}
          onChange={(_, value: BottomTab) => setBottomTab(value)}
          variant="fullWidth"
          sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}
        >
          <Tab label="Highlight" value="highlight" />
          <Tab label="Config" value="config" />
        </Tabs>
        <TabPanel active={bottomTab === 'highlight'} sx={{ flex: 1, overflowY: 'auto', minHeight: 0, p: 3 }}>
          <HighLighSettings />
        </TabPanel>
        <TabPanel active={bottomTab === 'config'} sx={{ flex: 1, overflowY: 'auto', minHeight: 0, p: 3 }} />
      </Box>
    </Box>
  );
};

export default ControlPanel;
