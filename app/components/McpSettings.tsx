'use client';

import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { invoke } from '@tauri-apps/api/core';

/// State of the embedded MCP server an agent connects to, as reported by the backend.
type McpStatus = {
  running: boolean;
  url: string | null;
  port: number | null;
};

const STOPPED: McpStatus = { running: false, url: null, port: null };

interface McpSettingsProps {
  port: number;
  onPortChange: (port: number) => void;
}

const isValidPort = (text: string) => {
  const port = Number(text);
  return text.trim() !== '' && Number.isInteger(port) && port >= 1 && port <= 65535;
};

/** Starts or stops the MCP server and sets its port. The server is never started automatically. */
const McpSettings: React.FC<McpSettingsProps> = ({ port, onPortChange }) => {
  const [status, setStatus] = useState<McpStatus>(STOPPED);
  const [error, setError] = useState<string | null>(null);
  // Text being typed in the port field, applied on Enter or when the field loses focus
  const [portDraft, setPortDraft] = useState<string | null>(null);

  useEffect(() => {
    // The backend keeps the server alive across webview reloads, and KAZESERIAL_MCP_PORT starts it at launch
    invoke<McpStatus>('get_mcp_status')
      .then(setStatus)
      .catch((err: unknown) => console.error(err));
  }, []);

  // The backend also prints the URL into the log as a system message
  const start = (serverPort: number) =>
    invoke<McpStatus>('start_mcp_server', { port: serverPort })
      .then(newStatus => {
        setStatus(newStatus);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)));

  const stop = () =>
    invoke<McpStatus>('stop_mcp_server')
      .then(setStatus)
      .catch((err: unknown) => console.error(err));

  const commitPort = () => {
    if (portDraft === null) return;
    setPortDraft(null);
    // An invalid value is dropped: the field shows the saved port again
    if (!isValidPort(portDraft) || Number(portDraft) === port) return;
    const newPort = Number(portDraft);
    onPortChange(newPort);
    // A running server is restarted on the new port
    if (status.running) {
      stop().then(() => start(newPort));
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <FormControlLabel
          label="Enable MCP server"
          control={
            <Checkbox
              size="small"
              checked={status.running}
              onChange={(e) => (e.target.checked ? start(port) : stop())}
            />
          }
        />
        <TextField
          label="Port"
          type="number"
          size="small"
          value={portDraft ?? String(port)}
          onChange={(e) => setPortDraft(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitPort();
          }}
          slotProps={{ htmlInput: { min: 1, max: 65535 } }}
          sx={{ width: 120 }}
        />
      </Box>
      {status.running && status.url && (
        <Typography variant="caption" sx={{ pl: 4, color: 'text.secondary' }}>
          Listening on {status.url}
        </Typography>
      )}
      {error && (
        <Typography variant="caption" color="error" sx={{ pl: 4 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
};

export default McpSettings;
