'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Divider from '@mui/material/Divider';
import McpSettings from './McpSettings';
import ColorPickerButton from './ColorPickerButton';
import Tooltip from '@mui/material/Tooltip';
import { AppConfig } from '../types/AppConfig';
import { formatTimestamp, TIMESTAMP_FORMATS } from '../utils/timestamp';

const CUSTOM_FORMAT = 'custom';
// Fixed time used to preview a custom pattern
const PREVIEW_TIME = new Date(2026, 9, 9, 14, 3, 27, 512).getTime();

interface IntegerFieldProps {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

/** Field for an integer ≥ 0: valid values are saved as typed, the saved value is shown again on blur */
const IntegerField: React.FC<IntegerFieldProps> = ({ label, value, disabled, onChange }) => {
  // Text being typed, kept while it is not a valid value
  const [draft, setDraft] = useState<string | null>(null);

  const onTextChange = (text: string) => {
    setDraft(text);
    const number = Number(text);
    if (text.trim() !== '' && Number.isInteger(number) && number >= 0) {
      onChange(number);
    }
  };

  return (
    <TextField
      label={label}
      type="number"
      size="small"
      value={draft ?? String(value)}
      disabled={disabled}
      onChange={(e) => onTextChange(e.target.value)}
      onBlur={() => setDraft(null)}
      slotProps={{ htmlInput: { min: 0, step: 100 } }}
      sx={{ width: 120 }}
    />
  );
};

interface ConfigSettingsProps {
  config: AppConfig;
  onConfigChange: (changes: Partial<AppConfig>) => void;
}

const ConfigSettings: React.FC<ConfigSettingsProps> = ({ config, onConfigChange }) => {
  // "Custom" stays selected while editing, even if the typed pattern matches a preset
  const [customFormat, setCustomFormat] = useState(false);
  const isCustomFormat = customFormat || !TIMESTAMP_FORMATS.includes(config.timestampFormat);

  const onFormatSelect = (value: string) => {
    setCustomFormat(value === CUSTOM_FORMAT);
    if (value !== CUSTOM_FORMAT) {
      onConfigChange({ timestampFormat: value });
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
        <IntegerField
          label="Delay (ms)"
          value={config.timestampInactivityMs}
          disabled={!config.showTimestamps || !config.timestampsAfterInactivityOnly}
          onChange={(timestampInactivityMs) => onConfigChange({ timestampInactivityMs })}
        />
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, pl: 3, pt: 1, flexWrap: 'wrap' }}>
        <TextField
          select
          label="Format"
          size="small"
          value={isCustomFormat ? CUSTOM_FORMAT : config.timestampFormat}
          disabled={!config.showTimestamps}
          onChange={(e) => onFormatSelect(e.target.value)}
          sx={{ minWidth: 220 }}
        >
          {TIMESTAMP_FORMATS.map(format => (
            <MenuItem key={format} value={format}>{format}</MenuItem>
          ))}
          <MenuItem value={CUSTOM_FORMAT}>Custom…</MenuItem>
        </TextField>
        {isCustomFormat && (
          <TextField
            label="Pattern"
            size="small"
            value={config.timestampFormat}
            disabled={!config.showTimestamps}
            onChange={(e) => onConfigChange({ timestampFormat: e.target.value })}
            helperText={`YYYY MM DD HH mm ss SSS — e.g. ${formatTimestamp(PREVIEW_TIME, config.timestampFormat)}`}
            sx={{ minWidth: 220 }}
          />
        )}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pt: 1 }}>
        <FormControlLabel
          label="Highlight new lines"
          control={
            <Checkbox
              size="small"
              checked={config.highlightNewLines}
              onChange={(e) => onConfigChange({ highlightNewLines: e.target.checked })}
            />
          }
        />
        <IntegerField
          label="Duration (ms)"
          value={config.newLineHighlightMs}
          disabled={!config.highlightNewLines}
          onChange={(newLineHighlightMs) => onConfigChange({ newLineHighlightMs })}
        />
        <Tooltip title="Highlight color (the alpha sets how visible it is)" placement="top" arrow>
          <span>
            <ColorPickerButton
              alpha
              value={config.newLineHighlightColor}
              disabled={!config.highlightNewLines}
              opacity={config.highlightNewLines ? 1 : 0.4}
              onChange={(newLineHighlightColor) => onConfigChange({ newLineHighlightColor })}
            />
          </span>
        </Tooltip>
      </Box>
      <Divider sx={{ my: 2 }} />
      <McpSettings port={config.mcpPort} onPortChange={(mcpPort) => onConfigChange({ mcpPort })} />
    </Box>
  );
};

export default ConfigSettings;
