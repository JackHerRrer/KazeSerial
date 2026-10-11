'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import { AppConfig } from '../types/AppConfig';

interface ConfigSettingsProps {
  config: AppConfig;
  onConfigChange: (changes: Partial<AppConfig>) => void;
}

const ConfigSettings: React.FC<ConfigSettingsProps> = ({ config, onConfigChange }) => {
  // Text being typed in the delay field; valid values are saved as typed, the field shows the
  // saved value again once it loses focus
  const [delayDraft, setDelayDraft] = useState<string | null>(null);

  const onDelayChange = (text: string) => {
    setDelayDraft(text);
    const delay = Number(text);
    if (text.trim() !== '' && Number.isInteger(delay) && delay >= 0) {
      onConfigChange({ timestampInactivityMs: delay });
    }
  };

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
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 3 }}>
        <FormControlLabel
          label="Only after inactivity"
          disabled={!config.showTimestamps}
          control={
            <Checkbox
              size="small"
              checked={config.timestampsAfterInactivityOnly}
              onChange={(e) => onConfigChange({ timestampsAfterInactivityOnly: e.target.checked })}
            />
          }
        />
        <TextField
          label="Delay (ms)"
          type="number"
          size="small"
          value={delayDraft ?? String(config.timestampInactivityMs)}
          disabled={!config.showTimestamps || !config.timestampsAfterInactivityOnly}
          onChange={(e) => onDelayChange(e.target.value)}
          onBlur={() => setDelayDraft(null)}
          slotProps={{ htmlInput: { min: 0, step: 100 } }}
          sx={{ width: 120 }}
        />
      </Box>
    </Box>
  );
};

export default ConfigSettings;
