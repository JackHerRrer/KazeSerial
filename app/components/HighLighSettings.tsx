'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Checkbox from '@mui/material/Checkbox';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { invoke } from "@tauri-apps/api/core";

import { create, writeTextFile, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';


interface HighligtConfig {
  id: number;
  text: string;
  color: string;
  is_regex: boolean;
  whole_line: boolean;
  focus: boolean;
  remove: boolean;
}

const OPTION_COLUMN_WIDTH = 36;
const OPTION_LABELS = ['Color', 'Regexp', 'Whole line', 'Focus', 'Remove'] as const;
const OPTION_LABEL_RIGHT_OFFSET_PX = 10;
const ACTION_COLUMN_WIDTH = 36;


export function useCustomHilightsState(p0?: never[]): [HighligtConfig[] | undefined, (newValue: HighligtConfig[]) => void] {
    const [value, setValue] = useState<HighligtConfig[]>();

    useEffect(() => {
        return () => {
        // do cleanup
        };
    }, [value]);

    const customSetValue = useCallback((newValue:HighligtConfig[]) => {
        setValue(newValue);
        invoke<string[]>("set_highlights", { highlights: newValue })
            .then((s) => {
                //console.log("Update highlights:",s);
                saveHighlightsToFile(newValue);
            }).catch((err: unknown) => {
                console.error(err);
            });
    }, []);
    // Sauvegarde des surlignages dans un fichier JSON local
    async function saveHighlightsToFile(highlightsToSave: HighligtConfig[]) {
        const filePath = 'highlight_settings.json';
        try {
            await writeTextFile(
            filePath,
            JSON.stringify(highlightsToSave, null, 2), { baseDir: BaseDirectory.AppConfig }
            );
        } catch (e) {
            console.log('Erreur lors de la sauvegarde : ' + e);
        }
    }
    return [value, customSetValue];
}

const HighLighSettings: React.FC = () => {
    const [highlights, setHighlights] = useCustomHilightsState([]);






    // Chargement des surlignages depuis le fichier JSON au démarrage
    async function loadHighlightsFromFile() {
        const filePath = 'highlight_settings.json';
        try {
            const result = await readTextFile(filePath, { baseDir: BaseDirectory.AppConfig });
            const highlights = JSON.parse(result);
            let tmpArr: HighligtConfig[] = [];
            highlights.forEach((h:HighligtConfig) => tmpArr.push({
                id: h.id,
                text: h.text,
                color: h.color,
                is_regex: h.is_regex ?? true,
                whole_line: h.whole_line ?? false,
                focus: h.remove ? false : h.focus ?? true,
                remove: h.remove ?? false,
            }));
            setHighlights(tmpArr);
        } catch (e) {
            console.log('Erreur lors du chargement : ' + e);
        }  
    }
    useEffect(() => {
        loadHighlightsFromFile();
        console.log("run once");
    }, []);
    const handleAddHighlight = async () => {
        if(highlights == undefined) {
            setHighlights([{ id: Date.now(), text: '', color: '#cc7f12', is_regex: true, whole_line: false, focus: true, remove: false }]);
            return;
        };
        setHighlights([...highlights, { id: Date.now(), text: '', color: '#cc7f12', is_regex: true, whole_line: false, focus: true, remove: false }]);
    };

    const handleRemoveHighlight = (id: number) => {
        if(highlights == undefined) return;
        setHighlights(highlights.filter(f => f.id !== id));
    };

    const handleHighlightChange = (id: number, field: keyof HighligtConfig, value: string) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => f.id === id ? { ...f, [field]: value } : f));
    };

    const handleHighlightIsRegexChange = (id: number, value: boolean) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => f.id === id ? { ...f, is_regex: value } : f));
    };

    const handleHighlightWholeLineChange = (id: number, value: boolean) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => f.id === id ? { ...f, whole_line: value } : f));
    };

    const handleHighlightFocusChange = (id: number, value: boolean) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => f.id === id ? { ...f, focus: value } : f));
    };

    const handleHighlightRemoveChange = (id: number, value: boolean) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => f.id === id ? { ...f, remove: value, focus: value ? false : f.focus } : f));
    };

    return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 2 }}>
        <Box sx={{ pr: 6, overflow: 'visible' }}>
            <Table size="small" sx={{ tableLayout: 'fixed', overflow: 'visible' }}>
                <TableHead sx={{ overflow: 'visible' }}>
                    <TableRow sx={{ overflow: 'visible' }}>
                        <TableCell sx={{ verticalAlign: 'bottom' }}>Sentence</TableCell>
                        {OPTION_LABELS.map((label) => (
                            <TableCell
                                key={label}
                                sx={{
                                    width: OPTION_COLUMN_WIDTH,
                                    minWidth: OPTION_COLUMN_WIDTH,
                                    maxWidth: OPTION_COLUMN_WIDTH,
                                    p: 0,
                                    height: '90px',
                                    overflow: 'visible',
                                    verticalAlign: 'bottom',
                                }}
                            >
                                <Box sx={{ position: 'relative', width: '100%', height: '100%', overflow: 'visible' }}>
                                    <Box sx={{
                                        position: 'absolute',
                                        bottom: 8,
                                        left: `${OPTION_LABEL_RIGHT_OFFSET_PX}px`,
                                        transformOrigin: 'left bottom',
                                        transform: 'rotate(-45deg)',
                                        whiteSpace: 'nowrap',
                                        lineHeight: 1,
                                    }}>
                                        {label}
                                    </Box>
                                </Box>
                            </TableCell>
                        ))}
                        <TableCell
                            sx={{
                                width: ACTION_COLUMN_WIDTH,
                                minWidth: ACTION_COLUMN_WIDTH,
                                maxWidth: ACTION_COLUMN_WIDTH,
                                p: 0,
                            }}
                        />
                    </TableRow>
                </TableHead>
                <TableBody>
                    {highlights?.map((filter) => (
                    <TableRow key={filter.id}>
                        <TableCell>
                            <TextField
                                size="small"
                                placeholder="Filter text"
                                value={filter.text}
                                onChange={(e) => handleHighlightChange(filter.id, 'text', e.target.value)}
                                fullWidth
                            />
                        </TableCell>
                        <TableCell
                            align="center"
                            sx={{ width: OPTION_COLUMN_WIDTH, minWidth: OPTION_COLUMN_WIDTH, maxWidth: OPTION_COLUMN_WIDTH, p: 0 }}
                        >
                            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                <input
                                    type="color"
                                    value={filter.color.slice(0, 7)}
                                    disabled={filter.remove}
                                    onChange={(e) => handleHighlightChange(filter.id, 'color', e.target.value)}
                                    style={{
                                        width: 26,
                                        height: 26,
                                        padding: 0,
                                        border: 'none',
                                        background: 'none',
                                        cursor: filter.remove ? 'not-allowed' : 'pointer',
                                        opacity: filter.remove ? 0.45 : 1,
                                    }}
                                />
                            </Box>
                        </TableCell>
                        <TableCell
                            align="center"
                            sx={{ width: OPTION_COLUMN_WIDTH, minWidth: OPTION_COLUMN_WIDTH, maxWidth: OPTION_COLUMN_WIDTH, p: 0 }}
                        >
                            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                <Checkbox
                                    size="small"
                                    checked={filter.is_regex}
                                    onChange={(e) => handleHighlightIsRegexChange(filter.id, e.target.checked)}
                                />
                            </Box>
                        </TableCell>
                        <TableCell
                            align="center"
                            sx={{ width: OPTION_COLUMN_WIDTH, minWidth: OPTION_COLUMN_WIDTH, maxWidth: OPTION_COLUMN_WIDTH, p: 0 }}
                        >
                            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                <Checkbox
                                    size="small"
                                    checked={filter.whole_line}
                                    onChange={(e) => handleHighlightWholeLineChange(filter.id, e.target.checked)}
                                />
                            </Box>
                        </TableCell>
                        <TableCell
                            align="center"
                            sx={{ width: OPTION_COLUMN_WIDTH, minWidth: OPTION_COLUMN_WIDTH, maxWidth: OPTION_COLUMN_WIDTH, p: 0 }}
                        >
                            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                <Checkbox
                                    size="small"
                                    checked={filter.focus}
                                    disabled={filter.remove}
                                    onChange={(e) => handleHighlightFocusChange(filter.id, e.target.checked)}
                                />
                            </Box>
                        </TableCell>
                        <TableCell
                            align="center"
                            sx={{ width: OPTION_COLUMN_WIDTH, minWidth: OPTION_COLUMN_WIDTH, maxWidth: OPTION_COLUMN_WIDTH, p: 0 }}
                        >
                            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                <Checkbox
                                    size="small"
                                    checked={filter.remove}
                                    onChange={(e) => handleHighlightRemoveChange(filter.id, e.target.checked)}
                                />
                            </Box>
                        </TableCell>
                        <TableCell
                            align="center"
                            sx={{ width: ACTION_COLUMN_WIDTH, minWidth: ACTION_COLUMN_WIDTH, maxWidth: ACTION_COLUMN_WIDTH, p: 0 }}
                        >
                            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                <IconButton size="small" sx={{ p: 0.5 }} onClick={() => handleRemoveHighlight(filter.id)}>
                                    <DeleteIcon />
                                </IconButton>
                            </Box>
                        </TableCell>
                    </TableRow>
                    ))}
                    <TableRow sx={{ '& td, & th': { borderBottom: 0 } }}>
                        <TableCell colSpan={7} align="center" sx={{ p: 0 }}>
                            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 34 }}>
                                <IconButton size="small" sx={{ p: 0.5 }} onClick={handleAddHighlight}>
                                    <AddIcon />
                                </IconButton>
                            </Box>
                        </TableCell>
                    </TableRow>
                </TableBody>
            </Table>
        </Box>
    </Box>
    );
};

export default HighLighSettings;

