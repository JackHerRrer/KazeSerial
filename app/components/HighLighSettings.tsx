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
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
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
const DRAG_COLUMN_WIDTH = 28;
const SENTENCE_MIN_COLUMN_WIDTH = 180;
const OPTION_COLUMNS = [
        { label: 'Color', width: COLOR_COLUMN_WIDTH },
        { label: 'Regexp', width: REGEX_COLUMN_WIDTH },
    { label: 'Focus', width: FOCUS_COLUMN_WIDTH },
    { label: 'Remove', width: REMOVE_COLUMN_WIDTH },
        { label: 'Select', width: SELECT_COLUMN_WIDTH },
        { label: 'Custom', width: CUSTOM_COLUMN_WIDTH },
] as const;
const OPTION_LABEL_RIGHT_OFFSET_PX = 10;
const ACTION_COLUMN_WIDTH = 36;
const TABLE_MIN_WIDTH =
    DRAG_COLUMN_WIDTH +
    SENTENCE_MIN_COLUMN_WIDTH +
    COLOR_COLUMN_WIDTH +
    REGEX_COLUMN_WIDTH +
    FOCUS_COLUMN_WIDTH +
    REMOVE_COLUMN_WIDTH +
    SELECT_COLUMN_WIDTH +
    CUSTOM_COLUMN_WIDTH +
    ACTION_COLUMN_WIDTH;


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
    const [draggedHighlightId, setDraggedHighlightId] = useState<number | null>(null);
    const [dropIndicator, setDropIndicator] = useState<{ id: number; position: 'before' | 'after' } | null>(null);

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
            setHighlights([{ id: Date.now(), text: '', color: '#cc7f12', is_regex: false, select_mode: 'match', custom_select: '', focus: true, remove: false }]);
            return;
        };
        setHighlights([...highlights, { id: Date.now(), text: '', color: '#cc7f12', is_regex: false, select_mode: 'match', custom_select: '', focus: true, remove: false }]);
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

    const reorderHighlights = (sourceId: number, targetId: number, position: 'before' | 'after') => {
        if (highlights == undefined || sourceId === targetId) return;

        const sourceIndex = highlights.findIndex((h) => h.id === sourceId);
        const targetIndex = highlights.findIndex((h) => h.id === targetId);

        if (sourceIndex < 0 || targetIndex < 0) return;

        const reordered = [...highlights];
        const [moved] = reordered.splice(sourceIndex, 1);

        const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
        const insertIndex = position === 'before' ? adjustedTargetIndex : adjustedTargetIndex + 1;

        reordered.splice(insertIndex, 0, moved);
        setHighlights(reordered);
    };

    const handleDragStart = (id: number) => (event: React.DragEvent<HTMLButtonElement>) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(id));
        setDraggedHighlightId(id);
        setDropIndicator(null);
    };

    const handleDragOverRow = (id: number) => (event: React.DragEvent<HTMLTableRowElement>) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';

        const rowRect = event.currentTarget.getBoundingClientRect();
        const rowMiddle = rowRect.top + rowRect.height / 2;
        const position = event.clientY < rowMiddle ? 'before' : 'after';

        setDropIndicator({ id, position });
    };

    const handleDropOnRow = (id: number) => (event: React.DragEvent<HTMLTableRowElement>) => {
        event.preventDefault();

        if (draggedHighlightId == undefined) {
            setDropIndicator(null);
            return;
        }

        const rowRect = event.currentTarget.getBoundingClientRect();
        const rowMiddle = rowRect.top + rowRect.height / 2;
        const position = event.clientY < rowMiddle ? 'before' : 'after';

        reorderHighlights(draggedHighlightId, id, position);
        setDraggedHighlightId(null);
        setDropIndicator(null);
    };

    const handleDragEnd = () => {
        setDraggedHighlightId(null);
        setDropIndicator(null);
    };

    return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 0, width: '100%' }}>
        <Box sx={{ overflowX: 'auto', overflowY: 'visible', width: '100%' }}>
            <Table size="small" sx={{ tableLayout: 'fixed', overflow: 'visible', width: '100%', minWidth: TABLE_MIN_WIDTH }}>
                <TableHead sx={{ overflow: 'visible' }}>
                    <TableRow sx={{ overflow: 'visible' }}>
                        <TableCell
                            sx={{
                                width: DRAG_COLUMN_WIDTH,
                                minWidth: DRAG_COLUMN_WIDTH,
                                maxWidth: DRAG_COLUMN_WIDTH,
                                p: 0,
                                borderBottom: 'none',
                            }}
                        />
                        <TableCell sx={{ verticalAlign: 'bottom', minWidth: SENTENCE_MIN_COLUMN_WIDTH }}>Sentence</TableCell>
                        {OPTION_COLUMNS.map((optionColumn) => {
                            const isHorizontalLabel = optionColumn.label === 'Select' || optionColumn.label === 'Custom';

                            return (
                                <TableCell
                                    key={optionColumn.label}
                                    sx={{
                                        width: optionColumn.width,
                                        minWidth: optionColumn.width,
                                        maxWidth: optionColumn.width,
                                        p: 0,
                                        height: '58px',
                                        overflow: 'visible',
                                        verticalAlign: 'bottom',
                                    }}
                                >
                                    <Box sx={{ position: 'relative', width: '100%', height: '100%', overflow: 'visible' }}>
                                        <Box sx={{
                                            position: 'absolute',
                                            bottom: 2,
                                            left: isHorizontalLabel ? '50%' : `${OPTION_LABEL_RIGHT_OFFSET_PX}px`,
                                            transformOrigin: isHorizontalLabel ? 'center bottom' : 'left bottom',
                                            transform: isHorizontalLabel ? 'translateX(-50%)' : 'rotate(-45deg)',
                                            whiteSpace: 'nowrap',
                                            lineHeight: 1,
                                        }}>
                                            {optionColumn.label}
                                        </Box>
                                    </Box>
                                </TableCell>
                            );
                        })}
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
                    <TableRow
                        key={filter.id}
                        onDragOver={handleDragOverRow(filter.id)}
                        onDrop={handleDropOnRow(filter.id)}
                        sx={{
                            opacity: draggedHighlightId === filter.id ? 0.6 : 1,
                            '& td:not(:first-of-type)': {
                                borderTop: dropIndicator?.id === filter.id && dropIndicator.position === 'before' && draggedHighlightId !== filter.id
                                    ? '2px solid'
                                    : undefined,
                                borderBottom: dropIndicator?.id === filter.id && dropIndicator.position === 'after' && draggedHighlightId !== filter.id
                                    ? '2px solid'
                                    : undefined,
                                borderTopColor: dropIndicator?.id === filter.id && dropIndicator.position === 'before' && draggedHighlightId !== filter.id
                                    ? 'primary.main'
                                    : undefined,
                                borderBottomColor: dropIndicator?.id === filter.id && dropIndicator.position === 'after' && draggedHighlightId !== filter.id
                                    ? 'primary.main'
                                    : undefined,
                            },
                        }}
                    >
                        <TableCell
                            align="center"
                            sx={{
                                width: DRAG_COLUMN_WIDTH,
                                minWidth: DRAG_COLUMN_WIDTH,
                                maxWidth: DRAG_COLUMN_WIDTH,
                                p: 0,
                                borderBottom: 'none',
                            }}
                        >
                            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                <IconButton
                                    size="small"
                                    draggable
                                    onDragStart={handleDragStart(filter.id)}
                                    onDragEnd={handleDragEnd}
                                    sx={{ p: 0.25, cursor: 'grab', '&:active': { cursor: 'grabbing' } }}
                                    aria-label="Reorder filter"
                                    title="Drag to reorder"
                                >
                                    <DragIndicatorIcon fontSize="small" />
                                </IconButton>
                            </Box>
                        </TableCell>
                        <TableCell sx={{ minWidth: SENTENCE_MIN_COLUMN_WIDTH }}>
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
                        <TableCell colSpan={9} align="center" sx={{ p: 0 }}>
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

