'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import { AppConfig } from '../types/AppConfig';

interface ConfigSettingsProps {
  config: AppConfig;
  onConfigChange: (changes: Partial<AppConfig>) => void;
}

const ConfigSettings: React.FC<ConfigSettingsProps> = ({ config, onConfigChange }) => {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <FormControlLabel
        label="Show line numbers"
        control={
          <Checkbox
            size="small"
            checked={config.showLineNumbers}
            onChange={(e) => onConfigChange({ showLineNumbers: e.target.checked })}
          />
        }
      />
      <FormControlLabel
        label="Show timestamps"
        control={
          <Checkbox
            size="small"
            checked={config.showTimestamps}
            onChange={(e) => onConfigChange({ showTimestamps: e.target.checked })}
          />
        }
      />
      <FormControlLabel
        label="Include timestamps in copied and saved text"
        disabled={!config.showTimestamps}
        sx={{ pl: 3 }}
        control={
          <Checkbox
            size="small"
            checked={config.timestampsInText}
            onChange={(e) => onConfigChange({ timestampsInText: e.target.checked })}
          />
        }
      />
    </Box>
  );
};

export default ConfigSettings;
