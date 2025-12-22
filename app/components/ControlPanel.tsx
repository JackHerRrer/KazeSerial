'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import SerialSettings from './SerialSettings';
import HighLighSettings from './HighLighSettings';
import ButtonGroup from '@mui/material/ButtonGroup';
import RemoveSentenceSettings from './SentenceRemovalSettings';
import FileSettings from './FileSettings';
import { SerialMessage } from '../types/SerialMessage';

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
  isAutoScrollEnabled: boolean;
  onToggleAutoScroll: () => void;
  onClickClearLog : () => void;
  onClickClearFocusLog : () => void;
  logs: SerialMessage[];
  focusLogs: SerialMessage[];
}

const ControlPanel: React.FC<ControlPanelProps> = ({
  onAppendLogs,
  onRegenerateLogs,
  isAutoScrollEnabled,
  onToggleAutoScroll,
  onClickClearLog,
  onClickClearFocusLog,
  logs,
  focusLogs
}) => {
  const [tabValue, setTabValue] = useState(0);

  const handleChange = (event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };
  const onClearAllLogs = useCallback(() => {
    onClickClearLog();
    onClickClearFocusLog();
  }, [onClickClearLog, onClickClearFocusLog]);

  return (
    <Box sx={{ width: '100%', borderLeft: '1px solid #333' }}>
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tabValue} onChange={handleChange} aria-label="control panel tabs">
          <Tab label="Serial" {...a11yProps(0)} />
          <Tab label="Demo" {...a11yProps(1)} />
          <Tab label="File" {...a11yProps(2)} />
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

      <TabPanel value={tabValue} index={2}>
        <FileSettings logs={logs} focusLogs={focusLogs} />
      </TabPanel>
      <Box sx={{ p:3 }}>
        <ButtonGroup variant="outlined" size="small" aria-label="Basic button group" sx={{ pb:2 }}>
          <Button onClick={onClearAllLogs}>
            Clear All Logs
          </Button>
          <Button onClick={onClickClearLog}>
            Clear Logs
          </Button>
          <Button onClick={onClickClearFocusLog}>
            Clear Focus Logs
          </Button>
        </ButtonGroup>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 , pb:2}}>
            <Button  variant="outlined" size="small"  onClick={onToggleAutoScroll}>
            {isAutoScrollEnabled ? 'Disable Auto-Scroll' : 'Enable Auto-Scroll'}
            </Button>
        </Box>
        <HighLighSettings />
        <RemoveSentenceSettings />
      </Box>
    </Box>
  );
};

export default ControlPanel;
function derive(newValue: any) {
  throw new Error('Function not implemented.');
}

