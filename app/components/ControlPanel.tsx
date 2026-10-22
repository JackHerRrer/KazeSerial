'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import SerialSettings from './SerialSettings';
import FileSettings from './FileSettings';
import HighLighSettings from './HighLighSettings';
import ConfigSettings from './ConfigSettings';
import { AppConfig } from '../types/AppConfig';

type MainTab = 'source' | 'highlight' | 'config';
type SourceTab = 'serial' | 'file';

// Panels stay mounted when inactive so their internal state (connection, rules...) is preserved
const TabPanel: React.FC<{ active: boolean; children?: React.ReactNode; sx?: object }> = ({ active, children, sx }) => (
  <Box role="tabpanel" hidden={!active} sx={{ display: active ? 'block' : 'none', ...sx }}>
    {children}
  </Box>
);

interface ControlPanelProps {
  config: AppConfig;
  onConfigChange: (changes: Partial<AppConfig>) => void;
}

const ControlPanel: React.FC<ControlPanelProps> = ({ config, onConfigChange }) => {
  const [mainTab, setMainTab] = useState<MainTab>('source');
  const [sourceTab, setSourceTab] = useState<SourceTab>('serial');

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Tabs
        value={mainTab}
        onChange={(_, value: MainTab) => setMainTab(value)}
        variant="fullWidth"
        sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}
      >
        <Tab label="Source" value="source" />
        <Tab label="Highlight" value="highlight" />
        <Tab label="Config" value="config" />
      </Tabs>
      <TabPanel active={mainTab === 'source'} sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <Tabs
          value={sourceTab}
          onChange={(_, value: SourceTab) => setSourceTab(value)}
          // Smaller and aligned on the left so they read as secondary to the main tabs; the tab padding
          // brings their labels in line with the panel content
          sx={{
            px: 1.5,
            pt: 1,
            minHeight: 36,
            '& .MuiTab-root': { minHeight: 36, minWidth: 0, px: 1.5, py: 0.5, fontSize: '0.8125rem' },
          }}
        >
          <Tab label="Serial" value="serial" />
          <Tab label="File" value="file" />
        </Tabs>
        <TabPanel active={sourceTab === 'serial'} sx={{ p: 3 }}>
          <SerialSettings autoReconnect={config.autoReconnect} />
        </TabPanel>
        <TabPanel active={sourceTab === 'file'} sx={{ p: 3 }}>
          <FileSettings />
        </TabPanel>
      </TabPanel>
      <TabPanel active={mainTab === 'highlight'} sx={{ flex: 1, overflowY: 'auto', minHeight: 0, p: 3 }}>
        <HighLighSettings />
      </TabPanel>
      <TabPanel active={mainTab === 'config'} sx={{ flex: 1, overflowY: 'auto', minHeight: 0, p: 3 }}>
        <ConfigSettings config={config} onConfigChange={onConfigChange} />
      </TabPanel>
    </Box>
  );
};

// Memoized: the main page renders with every new log line, the settings only change on user input
export default React.memo(ControlPanel);
