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
import Tooltip from '@mui/material/Tooltip';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { invoke } from "@tauri-apps/api/core";

import { writeTextFile, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';


type HighlightSelectMode = 'match' | 'whole_line' | 'custom';

interface AdvancedSelection {
    id: number;
    color: string;
    selector: string;
}

interface HighligtConfig {
  id: number;
  text: string;
  color: string;
  is_regex: boolean;
    whole_line: boolean;
    advanced: boolean;
    advanced_selections: AdvancedSelection[];
  focus: boolean;
  remove: boolean;
}

interface PersistedAdvancedSelection {
    id?: number;
    color?: string;
    selector?: string;
    custom_select?: string;
}

interface PersistedHighlightConfig {
    id?: number;
    text?: string;
    color?: string;
    is_regex?: boolean;
    whole_line?: boolean;
    advanced?: boolean;
    advanced_selections?: PersistedAdvancedSelection[];
    focus?: boolean;
    remove?: boolean;
    select_mode?: HighlightSelectMode;
    custom_select?: string;
}

interface HighlightMessagePayload {
    id: number;
    text: string;
    color: string;
    is_regex: boolean;
    select_mode: HighlightSelectMode;
    custom_select: string;
    whole_line: boolean;
    focus: boolean;
    remove: boolean;
    advanced_selections?: Array<{
        color: string;
        custom_select: string;
    }>;
}

const DEFAULT_HIGHLIGHT_COLOR = '#cc7f12';
const COLOR_COLUMN_WIDTH = 36;
const REGEX_COLUMN_WIDTH = 36;
const FOCUS_COLUMN_WIDTH = 36;
const REMOVE_COLUMN_WIDTH = 36;
const WHOLE_LINE_COLUMN_WIDTH = 36;
const ADVANCED_COLUMN_WIDTH = 36;
const DRAG_COLUMN_WIDTH = 28;
const SENTENCE_MIN_COLUMN_WIDTH = 180;
const OPTION_COLUMNS = [
        { label: 'Color', width: COLOR_COLUMN_WIDTH },
        { label: 'Regexp', width: REGEX_COLUMN_WIDTH },
    { label: 'Focus', width: FOCUS_COLUMN_WIDTH },
    { label: 'Remove', width: REMOVE_COLUMN_WIDTH },
        { label: 'Whole line', width: WHOLE_LINE_COLUMN_WIDTH },
        { label: 'Advanced', width: ADVANCED_COLUMN_WIDTH },
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
    WHOLE_LINE_COLUMN_WIDTH +
    ADVANCED_COLUMN_WIDTH +
    ACTION_COLUMN_WIDTH;

const createAdvancedSelection = (
    color: string = DEFAULT_HIGHLIGHT_COLOR,
    selector: string = '',
): AdvancedSelection => ({
    id: Date.now() + Math.floor(Math.random() * 1000000),
    color,
    selector,
});

const createDefaultHighlight = (): HighligtConfig => ({
    id: Date.now() + Math.floor(Math.random() * 1000000),
    text: '',
    color: DEFAULT_HIGHLIGHT_COLOR,
    is_regex: false,
    whole_line: false,
    advanced: false,
    advanced_selections: [],
    focus: true,
    remove: false,
});

const toHighlightPayload = (highlights: HighligtConfig[]): HighlightMessagePayload[] => {
    const payload: HighlightMessagePayload[] = [];

    highlights.forEach((highlight) => {
        if (highlight.advanced && highlight.is_regex) {
            const advancedSelectionsPayload =
                highlight.advanced_selections.length > 0
                    ? highlight.advanced_selections
                    : [{ id: highlight.id, color: highlight.color, selector: '' }];

            payload.push({
                id: highlight.id,
                text: highlight.text,
                color: highlight.color,
                is_regex: highlight.is_regex,
                select_mode: 'custom',
                custom_select: '',
                whole_line: false,
                focus: highlight.focus,
                remove: highlight.remove,
                advanced_selections: advancedSelectionsPayload.map((selection) => ({
                    color: selection.color,
                    custom_select: selection.selector,
                })),
            });
            return;
        }

        payload.push({
            id: highlight.id,
            text: highlight.text,
            color: highlight.color,
            is_regex: highlight.is_regex,
            select_mode: highlight.whole_line ? 'whole_line' : 'match',
            custom_select: '',
            whole_line: highlight.whole_line,
            focus: highlight.focus,
            remove: highlight.remove,
        });
    });

    return payload;
};


export function useCustomHilightsState(p0?: never[]): [HighligtConfig[] | undefined, (newValue: HighligtConfig[]) => void] {
    const [value, setValue] = useState<HighligtConfig[]>();

    useEffect(() => {
        return () => {
        // do cleanup
        };
    }, [value]);

    const customSetValue = useCallback((newValue: HighligtConfig[]) => {
        setValue(newValue);
        invoke<void>("set_highlights", { highlights: toHighlightPayload(newValue) })
            .then(() => {
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
            highlights.forEach((h, index) => {
                const isRegex = h.is_regex ?? true;
                const color = h.color ?? DEFAULT_HIGHLIGHT_COLOR;
                const selectMode = normalizeSelectMode(isRegex, getSelectModeFromPersisted(h));

                const explicitAdvanced = typeof h.advanced === 'boolean' ? h.advanced : selectMode === 'custom';
                const advancedEnabled = explicitAdvanced && isRegex;

                const persistedAdvancedSelections = (h.advanced_selections ?? []).map((selection, selectionIndex) => ({
                    id: selection.id ?? Date.now() + index + selectionIndex,
                    color: selection.color ?? color,
                    selector: selection.selector ?? selection.custom_select ?? '',
                }));

                const advancedSelections = advancedEnabled
                    ? (persistedAdvancedSelections.length > 0
                        ? persistedAdvancedSelections
                        : [createAdvancedSelection(color, h.custom_select ?? '')])
                    : [];

                tmpArr.push({
                    id: h.id ?? Date.now() + index,
                    text: h.text ?? '',
                    color,
                    is_regex: isRegex,
                    whole_line: advancedEnabled ? false : (h.whole_line ?? selectMode === 'whole_line'),
                    advanced: advancedEnabled,
                    advanced_selections: advancedSelections,
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
            setHighlights([createDefaultHighlight()]);
            return;
        }
        setHighlights([...highlights, createDefaultHighlight()]);
    };

    const handleRemoveHighlight = (id: number) => {
        if(highlights == undefined) return;
        setHighlights(highlights.filter(f => f.id !== id));
    };

    const handleHighlightChange = (id: number, field: 'text' | 'color', value: string) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => f.id === id ? { ...f, [field]: value } : f));
    };

    const handleHighlightIsRegexChange = (id: number, value: boolean) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => {
            if (f.id !== id) {
                return f;
            }

            if (!value) {
                return {
                    ...f,
                    is_regex: false,
                    advanced: false,
                    advanced_selections: [],
                };
            }

            return {
                ...f,
                is_regex: true,
            };
        }));
    };

    const handleHighlightWholeLineChange = (id: number, value: boolean) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => {
            if (f.id !== id) {
                return f;
            }

            return {
                ...f,
                whole_line: f.advanced ? false : value,
            };
        }));
    };

    const handleHighlightAdvancedChange = (id: number, value: boolean) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => {
            if (f.id !== id) {
                return f;
            }

            if (!value) {
                return {
                    ...f,
                    advanced: false,
                    advanced_selections: [],
                };
            }

            if (!f.is_regex) {
                return {
                    ...f,
                    advanced: false,
                    advanced_selections: [],
                };
            }

            return {
                ...f,
                advanced: true,
                whole_line: false,
                advanced_selections: f.advanced_selections.length > 0
                    ? f.advanced_selections
                    : [createAdvancedSelection(f.color, '')],
            };
        }));
    };

    const handleAddAdvancedSelection = (id: number) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => {
            if (f.id !== id) {
                return f;
            }

            return {
                ...f,
                advanced_selections: [
                    ...f.advanced_selections,
                    createAdvancedSelection(f.color, ''),
                ],
            };
        }));
    };

    const handleRemoveAdvancedSelection = (id: number, selectionId: number) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => {
            if (f.id !== id) {
                return f;
            }

            if (f.advanced_selections.length <= 1) {
                return f;
            }

            return {
                ...f,
                advanced_selections: f.advanced_selections.filter(s => s.id !== selectionId),
            };
        }));
    };

    const handleAdvancedSelectionChange = (
        id: number,
        selectionId: number,
        field: 'color' | 'selector',
        value: string,
    ) => {
        if(highlights == undefined) return;
        setHighlights(highlights.map(f => {
            if (f.id !== id) {
                return f;
            }

            return {
                ...f,
                advanced_selections: f.advanced_selections.map((selection) =>
                    selection.id === selectionId ? { ...selection, [field]: value } : selection,
                ),
            };
        }));
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
                            <React.Fragment key={filter.id}>
                                <TableRow
                                    onDragOver={handleDragOverRow(filter.id)}
                                    onDrop={handleDropOnRow(filter.id)}
                                    sx={{
                                        opacity: draggedHighlightId === filter.id ? 0.6 : 1,
                                        ...(filter.advanced && filter.advanced_selections.length > 0 && { '& td, & th': { borderBottom: 'none' } }),
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
                                                disabled={filter.remove || filter.advanced}
                                                onChange={(e) => handleHighlightChange(filter.id, 'color', e.target.value)}
                                                style={{
                                                    width: 26,
                                                    height: 26,
                                                    padding: 0,
                                                    border: 'none',
                                                    background: 'none',
                                                    cursor: (filter.remove || filter.advanced) ? 'not-allowed' : 'pointer',
                                                    opacity: filter.advanced ? 0.2 : filter.remove ? 0.45 : 1,
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
                                        sx={{ width: WHOLE_LINE_COLUMN_WIDTH, minWidth: WHOLE_LINE_COLUMN_WIDTH, maxWidth: WHOLE_LINE_COLUMN_WIDTH, p: 0 }}
                                    >
                                        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                            <Checkbox
                                                size="small"
                                                checked={filter.whole_line}
                                                disabled={filter.advanced}
                                                onChange={(e) => handleHighlightWholeLineChange(filter.id, e.target.checked)}
                                            />
                                        </Box>
                                    </TableCell>
                                    <TableCell
                                        align="center"
                                        sx={{ width: ADVANCED_COLUMN_WIDTH, minWidth: ADVANCED_COLUMN_WIDTH, maxWidth: ADVANCED_COLUMN_WIDTH, p: 0 }}
                                    >
                                        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                            <Checkbox
                                                size="small"
                                                checked={filter.advanced}
                                                disabled={!filter.is_regex}
                                                onChange={(e) => handleHighlightAdvancedChange(filter.id, e.target.checked)}
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

                                {filter.advanced && filter.advanced_selections.map((selection, selIdx) => (
                                    <TableRow
                                        key={`${filter.id}-advanced-${selection.id}`}
                                        onDragOver={handleDragOverRow(filter.id)}
                                        onDrop={handleDropOnRow(filter.id)}
                                        sx={{ opacity: draggedHighlightId === filter.id ? 0.6 : 1 }}
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
                                        />
                                        <TableCell sx={{ minWidth: SENTENCE_MIN_COLUMN_WIDTH, p: 0.5, borderBottom: selIdx === filter.advanced_selections.length - 1 ? undefined : 'none' }}>
                                            <Box sx={{ minHeight: 32 }} />
                                        </TableCell>
                                        <TableCell
                                            align="center"
                                            sx={{ width: COLOR_COLUMN_WIDTH, minWidth: COLOR_COLUMN_WIDTH, maxWidth: COLOR_COLUMN_WIDTH, p: 0, borderBottom: selIdx === filter.advanced_selections.length - 1 ? undefined : 'none' }}
                                        >
                                            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                                <input
                                                    type="color"
                                                    value={selection.color.slice(0, 7)}
                                                    disabled={filter.remove}
                                                    onChange={(e) =>
                                                        handleAdvancedSelectionChange(filter.id, selection.id, 'color', e.target.value)
                                                    }
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
                                        <TableCell colSpan={5} sx={{ p: 0.5, borderBottom: selIdx === filter.advanced_selections.length - 1 ? undefined : 'none' }}>
                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                <Tooltip
                                                    title="Enter the numbers of the capture groups from your regular expression that you want to colorize, separated by commas (e.g. 1,2). In a regex, parentheses define groups numbered left to right starting at 1. For example, with the regex '(\w+): (\d+)', group 1 matches the word before the colon and group 2 matches the number after it."
                                                    placement="top"
                                                    arrow
                                                >
                                                    <span>
                                                <TextField
                                                    size="small"
                                                    placeholder="1,2"
                                                    value={selection.selector}
                                                    onChange={(e) =>
                                                        handleAdvancedSelectionChange(filter.id, selection.id, 'selector', e.target.value)
                                                    }
                                                    disabled={filter.remove}
                                                    sx={{
                                                        width: 110,
                                                        '& .MuiInputBase-input': {
                                                            fontSize: '0.75rem',
                                                            py: 0.5,
                                                        },
                                                    }}
                                                />
                                                    </span>
                                                </Tooltip>
                                                <IconButton
                                                    size="small"
                                                    sx={{ p: 0.5 }}
                                                    onClick={() => handleRemoveAdvancedSelection(filter.id, selection.id)}
                                                    disabled={filter.advanced_selections.length <= 1}
                                                >
                                                    <DeleteIcon fontSize="small" />
                                                </IconButton>
                                                <IconButton
                                                    size="small"
                                                    sx={{ p: 0.5 }}
                                                    onClick={() => handleAddAdvancedSelection(filter.id)}
                                                >
                                                    <AddIcon fontSize="small" />
                                                </IconButton>
                                            </Box>
                                        </TableCell>
                                        <TableCell sx={{ width: ACTION_COLUMN_WIDTH, minWidth: ACTION_COLUMN_WIDTH, maxWidth: ACTION_COLUMN_WIDTH, p: 0, borderBottom: selIdx === filter.advanced_selections.length - 1 ? undefined : 'none' }} />
                                    </TableRow>
                                ))}
                            </React.Fragment>
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

