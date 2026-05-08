'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import SerialSettings from './SerialSettings';
import HighLighSettings from './HighLighSettings';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`simple-tabpanel-${index}`}
      aria-labelledby={`simple-tab-${index}`}
      {...other}
    >
      {value === index && (
        <Box sx={{ p: 3 , borderBottom: 1, borderColor: 'divider' }}>
          {children}
        </Box>
      )}
    </div>
  );
}

function a11yProps(index: number) {
  return {
    id: `simple-tab-${index}`,
    'aria-controls': `simple-tabpanel-${index}`,
  };
}

interface ControlPanelProps {
  onAppendLogs: () => void;
  onRegenerateLogs: () => void;
}

const ControlPanel: React.FC<ControlPanelProps> = ({
  onAppendLogs,
  onRegenerateLogs,
}) => {
  const [tabValue, setTabValue] = useState(0);

  const handleChange = (event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tabValue} onChange={handleChange} aria-label="control panel tabs">
          <Tab label="Serial" {...a11yProps(0)} />
          <Tab label="Demo" {...a11yProps(1)} />
        </Tabs>
      </Box>
      <TabPanel value={tabValue} index={0}>
        <SerialSettings />
      </TabPanel>
      <TabPanel value={tabValue} index={1}>
        <Box sx={{  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,  }}>
          <Button variant="outlined" size="small" onClick={onAppendLogs}>
            Append 10 Logs
          </Button>
          <Button variant="outlined" size="small" onClick={onRegenerateLogs}>
            Regenerate Logs
          </Button>
        </Box>
      </TabPanel>

      <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0, p: 3 }}>
        <HighLighSettings />
      </Box>
    </Box>
  );
};

export default ControlPanel;
function derive(newValue: any) {
  throw new Error('Function not implemented.');
}

