'use client';

import React, { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import InputBase from '@mui/material/InputBase';
import IconButton from '@mui/material/IconButton';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import SendIcon from '@mui/icons-material/Send';
import { invoke } from '@tauri-apps/api/core';
import { type LineEnding } from '../types/AppConfig';

// Most recent texts sent, recalled with Up / Down
const HISTORY_SIZE = 100;

const LINE_ENDINGS: { value: LineEnding; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'lf', label: 'LF' },
  { value: 'cr', label: 'CR' },
  { value: 'crlf', label: 'CRLF' },
];

interface SendBarProps {
  // The serial port is open: the bar is disabled otherwise
  connected: boolean;
  lineEnding: LineEnding;
  onLineEndingChange: (lineEnding: LineEnding) => void;
}

/**
 * Input bar under the main terminal: Enter sends the text, followed by the chosen line ending, to
 * the serial port. Up / Down recall the texts sent since launch, as in a shell.
 */
const SendBar: React.FC<SendBarProps> = ({ connected, lineEnding, onLineEndingChange }) => {
  const [text, setText] = useState('');
  const historyRef = useRef<string[]>([]);
  // Position in the history while recalling it, null while editing a new text
  const historyIndexRef = useRef<number | null>(null);
  // Text being edited before recalling the history, restored by Down past the most recent text
  const draftRef = useRef('');

  // An empty text sends the line ending alone, e.g. to get a prompt back
  const send = () => {
    const sent = text;
    invoke<void>('send_serial', { text: sent, lineEnding })
      .then(() => {
        const history = historyRef.current;
        if (sent !== '' && history[history.length - 1] !== sent) {
          history.push(sent);
          if (history.length > HISTORY_SIZE) history.shift();
        }
        historyIndexRef.current = null;
        setText(previous => previous === sent ? '' : previous);
      })
      // Kept in the field to send it again; the failure is reported in the log by the backend
      .catch((err: unknown) => console.error(err));
  };

  const recall = (step: -1 | 1) => {
    const history = historyRef.current;
    const current = historyIndexRef.current;
    if (current === null) {
      if (step === 1 || history.length === 0) return;
      draftRef.current = text;
      historyIndexRef.current = history.length - 1;
    } else if (current + step < 0) {
      return;
    } else if (current + step >= history.length) {
      historyIndexRef.current = null;
      setText(draftRef.current);
      return;
    } else {
      historyIndexRef.current = current + step;
    }
    setText(history[historyIndexRef.current]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter also validates an input method composition
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') send();
    else if (e.key === 'ArrowUp') recall(-1);
    else if (e.key === 'ArrowDown') recall(1);
    else return;
    e.preventDefault();
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        mt: 0.5,
        pl: 1,
        pr: 0.5,
        bgcolor: '#1e1e1e',
        border: '1px solid #333',
        borderRadius: 1,
        flexShrink: 0,
      }}
    >
      <InputBase
        fullWidth
        disabled={!connected}
        placeholder={connected ? 'Send to the serial port (Enter, ↑/↓ for history)' : 'Not connected'}
        value={text}
        onChange={(e) => {
          historyIndexRef.current = null;
          setText(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        inputProps={{ 'aria-label': 'text to send', spellCheck: false }}
        sx={{ fontFamily: 'monospace', fontSize: '0.875rem', color: '#d4d4d4' }}
      />
      <Tooltip title="Line ending appended to the text sent" placement="top" arrow>
        <Select
          variant="standard"
          disableUnderline
          value={lineEnding}
          onChange={(e) => onLineEndingChange(e.target.value as LineEnding)}
          inputProps={{ 'aria-label': 'line ending' }}
          sx={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'text.secondary', minWidth: 56 }}
        >
          {LINE_ENDINGS.map(({ value, label }) => (
            <MenuItem key={value} value={value} sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{label}</MenuItem>
          ))}
        </Select>
      </Tooltip>
      <Tooltip title="Send (Enter)" placement="top" arrow>
        {/* Wrapped so the tooltip still works while the button is disabled */}
        <span>
          <IconButton aria-label="send" size="small" disabled={!connected} onClick={send}>
            <SendIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
};

export default SendBar;
