'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';

const FileSettings: React.FC = () => {
  const [path, setPath] = useState('');
  const [isFileWatching, setIsFileWatching] = useState(false);

  React.useEffect(() => {
    // Emitted when the backend follow loop exits (user stop or file removed)
    const unlisten = listen('file-watch-stopped', () => {
      setIsFileWatching(false);
    });
    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  const handleBrowse = async () => {
    const selected = await openDialog({ directory: false, multiple: false }).catch(() => undefined);
    if (selected) {
      setPath(selected);
    }
  };

  const handleFollow = () => {
    if (isFileWatching) {
      invoke<void>('stop_file_watch').catch((err: unknown) => console.error(err));
      setIsFileWatching(false);
    } else {
      invoke<void>('watch_file', { path })
        .then(() => setIsFileWatching(true))
        .catch((err: unknown) => console.error(err));
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, width: '100%' }}>
      <Tooltip title="Select a file to follow" placement="top" arrow>
        <span>
          <IconButton
            aria-label="select file"
            size="small"
            color="primary"
            onClick={handleBrowse}
            disabled={isFileWatching}
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              width: 40,
              height: 40,
            }}
          >
            <FolderOpenIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <TextField
        label="File"
        size="small"
        value={path}
        title={path}
        disabled={isFileWatching}
        slotProps={{ input: { readOnly: true } }}
        sx={{
          flex: 1,
          minWidth: 0,
          '& .MuiInputBase-input': {
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }}
      />
      <Tooltip title={isFileWatching ? 'Stop following file' : 'Follow file (tail -f)'} placement="top" arrow>
        <span>
          <Button
            variant="outlined"
            size="small"
            color="primary"
            onClick={handleFollow}
            disabled={!isFileWatching && path === ''}
            sx={{ whiteSpace: 'nowrap', height: 40 }}
          >
            {isFileWatching ? 'Stop' : 'Follow'}
          </Button>
        </span>
      </Tooltip>
    </Box>
  );
};

export default FileSettings;
