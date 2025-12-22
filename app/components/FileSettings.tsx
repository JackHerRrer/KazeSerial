'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { invoke } from "@tauri-apps/api/core";
import { ButtonGroup } from '@mui/material';
import { create, writeTextFile, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { open , save } from '@tauri-apps/plugin-dialog';
import { SerialMessage } from '../types/SerialMessage';

interface FileSettingsProps {
    logs: SerialMessage[];
    focusLogs: SerialMessage[];
}

const FileSettings: React.FC<FileSettingsProps> = ({ logs, focusLogs }) => {
    const isCancelled = React.useRef(false);


    React.useEffect(() => {
        return () => {
        isCancelled.current = true;
        };
    }, []);


    const handleSaveToFile = async () => {
        let logs_buff :string = "";
        for(let index in logs){
            if(logs[index].rawline != undefined){
                logs_buff += logs[index].rawline + "\n";
            } else {
                logs_buff += logs[index].message + "\n";
            }
        }
        const filePath = await save({
            filters: [{
            name: 'export',
            extensions: ['log']
            }]
        }).then((path) => {
            return path;
        }).catch((err: unknown) => {
            console.error(err);
        });
        if(filePath != undefined)
        {
            await writeTextFile(filePath, logs_buff);
        }
    };
    const handleSaveFocusToFile = async () => {
        let logs_buff :string = "";
        for(let index in focusLogs){
            if(focusLogs[index].rawline != undefined){
                logs_buff += focusLogs[index].rawline + "\n";
            } else {
                logs_buff += focusLogs[index].message + "\n";
            }
        }
        const filePath = await save({
            filters: [{
            name: 'export',
            extensions: ['log']
            }]
        }).then((path) => {
            return path;
        }).catch((err: unknown) => {
            console.error(err);
        });
        if(filePath != undefined)
        {
            await writeTextFile(filePath, logs_buff);
        }
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
            for (const line of contents.split("\n")){
                invoke<string[]>("add_logs_line", { line: line })
                .then((s) => {
                }).catch((err: unknown) => {
                    console.error(err);
                });
            }
        }
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <ButtonGroup variant="outlined" size="small" aria-label="Basic button group" sx={{ pb:2 }}>
            <Button onClick={handleSaveToFile}>
                    Save logs to file
            </Button>
            <Button onClick={handleSaveFocusToFile}>
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
