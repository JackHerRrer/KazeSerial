'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Checkbox from '@mui/material/Checkbox';
import Select, { SelectChangeEvent } from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { invoke } from "@tauri-apps/api/core";

import { writeTextFile, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';


type HighlightSelectMode = 'match' | 'whole_line' | 'custom';

interface HighligtConfig {
  id: number;
  text: string;
  color: string;
  is_regex: boolean;
    select_mode: HighlightSelectMode;
    custom_select: string;
  focus: boolean;
  remove: boolean;
}

interface PersistedHighlightConfig extends Partial<HighligtConfig> {
        whole_line?: boolean;
}

const COLOR_COLUMN_WIDTH = 36;
const REGEX_COLUMN_WIDTH = 36;
const SELECT_COLUMN_WIDTH = 110;
const CUSTOM_COLUMN_WIDTH = 80;
const FOCUS_COLUMN_WIDTH = 36;
const REMOVE_COLUMN_WIDTH = 36;
const OPTION_COLUMNS = [
        { label: 'Color', width: COLOR_COLUMN_WIDTH },
        { label: 'Regexp', width: REGEX_COLUMN_WIDTH },
        { label: 'Select', width: SELECT_COLUMN_WIDTH },
        { label: 'Custom', width: CUSTOM_COLUMN_WIDTH },
        { label: 'Focus', width: FOCUS_COLUMN_WIDTH },
        { label: 'Remove', width: REMOVE_COLUMN_WIDTH },
] as const;
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

    const isHighlightSelectMode = (value: unknown): value is HighlightSelectMode => {
        return value === 'match' || value === 'whole_line' || value === 'custom';
    };

    const getSelectModeFromPersisted = (highlight: PersistedHighlightConfig): HighlightSelectMode => {
        if (isHighlightSelectMode(highlight.select_mode)) {
            return highlight.select_mode;
        }
        if (highlight.whole_line) {
            return 'whole_line';
        }
        return 'match';
    };

    const normalizeSelectMode = (isRegex: boolean, selectMode: HighlightSelectMode): HighlightSelectMode => {
        if (!isRegex && selectMode === 'custom') {
            return 'match';
        }
        return selectMode;
    };






    // Chargement des surlignages depuis le fichier JSON au démarrage
    async function loadHighlightsFromFile() {
        const filePath = 'highlight_settings.json';
        try {
            const result = await readTextFile(filePath, { baseDir: BaseDirectory.AppConfig });
            const highlights = JSON.parse(result) as PersistedHighlightConfig[];
            let tmpArr: HighligtConfig[] = [];
            highlights.forEach((h) => {
                const isRegex = h.is_regex ?? true;
                const selectMode = normalizeSelectMode(isRegex, getSelectModeFromPersisted(h));
                tmpArr.push({
                    id: h.id ?? Date.now(),
                    text: h.text ?? '',
                    color: h.color ?? '#cc7f12',
                    is_regex: isRegex,
                    select_mode: selectMode,
                    custom_select: h.custom_select ?? '',
                    focus: h.remove ? false : h.focus ?? true,
                    remove: h.remove ?? false,
                });
            });
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
            setHighlights([{ id: Date.now(), text: '', color: '#cc7f12', is_regex: true, select_mode: 'match', custom_select: '', focus: true, remove: false }]);
            return;
        };
        setHighlights([...highlights, { id: Date.now(), text: '', color: '#cc7f12', is_regex: true, select_mode: 'match', custom_select: '', focus: true, remove: false }]);
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
        setHighlights(highlights.map(f => {
            if (f.id !== id) {
                return f;
            }
            return {
                ...f,
                is_regex: value,
                select_mode: normalizeSelectMode(value, f.select_mode),
            };
        }));
    };

    const handleHighlightSelectModeChange = (id: number, value: HighlightSelectMode) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => {
            if (f.id !== id) {
                return f;
            }
            return {
                ...f,
                select_mode: normalizeSelectMode(f.is_regex, value),
            };
        }));
    };

    const handleHighlightCustomSelectChange = (id: number, value: string) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => f.id === id ? { ...f, custom_select: value } : f));
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
                        {OPTION_COLUMNS.map((optionColumn) => (
                            <TableCell
                                key={optionColumn.label}
                                sx={{
                                    width: optionColumn.width,
                                    minWidth: optionColumn.width,
                                    maxWidth: optionColumn.width,
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
                                        {optionColumn.label}
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
                            sx={{ width: COLOR_COLUMN_WIDTH, minWidth: COLOR_COLUMN_WIDTH, maxWidth: COLOR_COLUMN_WIDTH, p: 0 }}
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
                            sx={{ width: REGEX_COLUMN_WIDTH, minWidth: REGEX_COLUMN_WIDTH, maxWidth: REGEX_COLUMN_WIDTH, p: 0 }}
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
                            sx={{ width: SELECT_COLUMN_WIDTH, minWidth: SELECT_COLUMN_WIDTH, maxWidth: SELECT_COLUMN_WIDTH, p: 0.5 }}
                        >
                            <Select
                                fullWidth
                                size="small"
                                value={filter.select_mode}
                                onChange={(e: SelectChangeEvent<HighlightSelectMode>) =>
                                    handleHighlightSelectModeChange(filter.id, e.target.value as HighlightSelectMode)
                                }
                                sx={{
                                    '& .MuiSelect-select': {
                                        py: 0.5,
                                        fontSize: '0.75rem',
                                    },
                                }}
                            >
                                <MenuItem value="match">Match</MenuItem>
                                <MenuItem value="whole_line">Line</MenuItem>
                                <MenuItem value="custom" disabled={!filter.is_regex}>Custom</MenuItem>
                            </Select>
                        </TableCell>
                        <TableCell
                            align="center"
                            sx={{ width: CUSTOM_COLUMN_WIDTH, minWidth: CUSTOM_COLUMN_WIDTH, maxWidth: CUSTOM_COLUMN_WIDTH, p: 0.5 }}
                        >
                            <TextField
                                size="small"
                                placeholder="1,2"
                                value={filter.custom_select}
                                onChange={(e) => handleHighlightCustomSelectChange(filter.id, e.target.value)}
                                fullWidth
                                disabled={!filter.is_regex || filter.select_mode !== 'custom'}
                                slotProps={{
                                    input: {
                                        sx: {
                                            fontSize: '0.75rem',
                                        },
                                    },
                                }}
                            />
                        </TableCell>
                        <TableCell
                            align="center"
                            sx={{ width: FOCUS_COLUMN_WIDTH, minWidth: FOCUS_COLUMN_WIDTH, maxWidth: FOCUS_COLUMN_WIDTH, p: 0 }}
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
                            sx={{ width: REMOVE_COLUMN_WIDTH, minWidth: REMOVE_COLUMN_WIDTH, maxWidth: REMOVE_COLUMN_WIDTH, p: 0 }}
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
                        <TableCell colSpan={8} align="center" sx={{ p: 0 }}>
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

