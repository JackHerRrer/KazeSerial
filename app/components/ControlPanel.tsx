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

type MainTab = 'config' | 'highlight';
type SourceTab = 'serial' | 'file';

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

interface ControlPanelProps {
  config: AppConfig;
  onConfigChange: (changes: Partial<AppConfig>) => void;
}

const ControlPanel: React.FC<ControlPanelProps> = ({ config, onConfigChange }) => {
  const [mainTab, setMainTab] = useState<MainTab>('config');
  const [sourceTab, setSourceTab] = useState<SourceTab>('serial');

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Tabs
        value={mainTab}
        onChange={(_, value: MainTab) => setMainTab(value)}
        variant="fullWidth"
        sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}
      >
        <Tab label="Config" value="config" />
        <Tab label="Highlight" value="highlight" />
      </Tabs>
      <TabPanel active={mainTab === 'config'} sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
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
              <SerialSettings autoReconnect={config.autoReconnect} />
            </SourcePanel>
            <SourcePanel active={sourceTab === 'file'}>
              <FileSettings />
            </SourcePanel>
          </Box>
        </Box>
        <Box sx={{ p: 3 }}>
          <ConfigSettings config={config} onConfigChange={onConfigChange} />
        </Box>
      </TabPanel>
      <TabPanel active={mainTab === 'highlight'} sx={{ flex: 1, overflowY: 'auto', minHeight: 0, p: 3 }}>
        <HighLighSettings />
      </TabPanel>
    </Box>
  );
};

// Memoized: the main page renders with every new log line, the settings only change on user input
export default React.memo(ControlPanel);
