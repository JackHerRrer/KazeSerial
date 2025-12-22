'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { invoke } from "@tauri-apps/api/core";
import { ButtonGroup } from '@mui/material';
import { create, writeTextFile, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { open } from '@tauri-apps/plugin-dialog';
const FileSettings: React.FC = () => {
    const isCancelled = React.useRef(false);


    React.useEffect(() => {
        return () => {
        isCancelled.current = true;
        };
    }, []);


    const handleSaveToFile = () => {


    };
    const loadLogFile = async () => {
        // Open a selection dialog for directories
        const selected = await open({
            directory: false,
            multiple: false,
        });
        if (selected === null) {
            // user cancelled the selection
        } else {
            let contents = await readTextFile(selected, {});
            console.log(contents)
        }
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <ButtonGroup variant="outlined" size="small" aria-label="Basic button group" sx={{ pb:2 }}>
            <Button onClick={handleSaveToFile}>
                    Save logs to file
            </Button>
            <Button onClick={handleSaveToFile}>
                    Save focus logs to file
            </Button>
            <Button onClick={loadLogFile}>
                    Load log files
            </Button>
            </ButtonGroup>
        </Box>
    );
};

export default FileSettings;
