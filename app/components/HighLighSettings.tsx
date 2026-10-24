'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import SubdirectoryArrowRightIcon from '@mui/icons-material/SubdirectoryArrowRight';
import SaveIcon from '@mui/icons-material/Save';
import ColorPickerButton from './ColorPickerButton';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { writeTextFile, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog';


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
  case_sensitive: boolean;
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
    case_sensitive?: boolean;
    whole_line?: boolean;
    advanced?: boolean;
    advanced_selections?: PersistedAdvancedSelection[];
    focus?: boolean;
    remove?: boolean;
    select_mode?: HighlightSelectMode;
    custom_select?: string;
}

interface HighlightMessagePayload {
    text: string;
    color: string;
    is_regex: boolean;
    case_sensitive: boolean;
    select_mode: HighlightSelectMode;
    focus: boolean;
    remove: boolean;
    advanced_selections?: Array<{
        color: string;
        custom_select: string;
    }>;
}

const DEFAULT_HIGHLIGHT_COLOR = '#cc7f12';
const COLOR_COLUMN_WIDTH = 30;
const CASE_SENSITIVE_COLUMN_WIDTH = 30;
const REGEX_COLUMN_WIDTH = 30;
const FOCUS_COLUMN_WIDTH = 30;
const REMOVE_COLUMN_WIDTH = 30;
const WHOLE_LINE_COLUMN_WIDTH = 30;
const ADVANCED_COLUMN_WIDTH = 30;
const DRAG_COLUMN_WIDTH = 28;
const SENTENCE_MIN_COLUMN_WIDTH = 180;
const OPTION_COLUMNS = [
        { label: 'Color', width: COLOR_COLUMN_WIDTH },
        { label: 'Case sens.', width: CASE_SENSITIVE_COLUMN_WIDTH },
        { label: 'Regexp', width: REGEX_COLUMN_WIDTH },
    { label: 'Focus', width: FOCUS_COLUMN_WIDTH },
    { label: 'Remove', width: REMOVE_COLUMN_WIDTH },
        { label: 'Whole line', width: WHOLE_LINE_COLUMN_WIDTH },
        { label: 'Advanced', width: ADVANCED_COLUMN_WIDTH },
] as const;
const OPTION_LABEL_RIGHT_OFFSET_PX = 10;
// Text fields of the rules (search and capture groups): tighter padding than the small size so the rules take less height
// and the text starts close to the left edge, a bit less at the bottom so the text, mostly without descenders, looks centered
const RULE_INPUT_SX = { '& .MuiInputBase-input': { pt: 0.5, pb: '1px', pl: 0.7, pr: 1 } };
const ACTION_COLUMN_WIDTH = 36;
const TABLE_MIN_WIDTH =
    DRAG_COLUMN_WIDTH +
    SENTENCE_MIN_COLUMN_WIDTH +
    COLOR_COLUMN_WIDTH +
    CASE_SENSITIVE_COLUMN_WIDTH +
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

const isInvalidRegex = (text: string, isRegex: boolean): boolean => {
    if (!isRegex || text.length === 0) return false;
    try { new RegExp(text); return false; } catch { return true; }
};

const countCaptureGroups = (pattern: string): number => {
    try {
        // Use a dummy match to count; RegExp doesn't expose group count directly
        // so we inspect the exec result length on an empty string
        const m = new RegExp(`(${pattern})|`).exec('');
        return m ? m.length - 2 : 0;
    } catch { return 0; }
};

const hasInvalidGroup = (selector: string, pattern: string): boolean => {
    if (!selector.trim()) return false;
    const total = countCaptureGroups(pattern);
    return selector.split(',').some(part => {
        const n = parseInt(part.trim(), 10);
        return !isNaN(n) && (n < 1 || n > total);
    });
};

const createDefaultHighlight = (): HighligtConfig => ({
    id: Date.now() + Math.floor(Math.random() * 1000000),
    text: '',
    color: DEFAULT_HIGHLIGHT_COLOR,
    is_regex: false,
    case_sensitive: true,
    whole_line: false,
    advanced: false,
    advanced_selections: [],
    focus: true,
    remove: false,
});

const toHighlightPayload = (highlights: HighligtConfig[]): HighlightMessagePayload[] =>
    highlights.map((highlight) => {
        // Without any group selected, the backend colors the whole matches
        const isAdvanced = highlight.advanced && highlight.is_regex;
        return {
            text: highlight.text,
            color: highlight.color,
            is_regex: highlight.is_regex,
            case_sensitive: highlight.case_sensitive,
            select_mode: isAdvanced ? 'custom' : highlight.whole_line ? 'whole_line' : 'match',
            focus: highlight.focus,
            remove: highlight.remove,
            advanced_selections: isAdvanced
                ? highlight.advanced_selections.map((selection) => ({ color: selection.color, custom_select: selection.selector }))
                : undefined,
        };
    });


// Delay without any rule change before the logs are refreshed, so typing a pattern does not
// reprocess the whole log on every key
const AUTO_REFRESH_DELAY_MS = 300;

type SetHighlights = (newValue: HighligtConfig[], options?: { refresh?: boolean }) => void;

export function useCustomHilightsState(): [HighligtConfig[] | undefined, SetHighlights] {
    const [value, setValue] = useState<HighligtConfig[]>();
    const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => () => clearTimeout(refreshTimer.current), []);

    // The main and focus logs are refreshed with the new rules, unless `refresh` is false
    const customSetValue = useCallback<SetHighlights>((newValue, { refresh = true } = {}) => {
        setValue(newValue);
        invoke<void>('set_highlights', { highlights: toHighlightPayload(newValue) })
            .then(() => {
                if (refresh) {
                    clearTimeout(refreshTimer.current);
                    refreshTimer.current = setTimeout(() => {
                        invoke<void>('refresh_logs').catch((err: unknown) => console.error(err));
                    }, AUTO_REFRESH_DELAY_MS);
                }
                return saveHighlightsToFile(newValue);
            })
            .catch((err: unknown) => console.error(err));
    }, []);

    return [value, customSetValue];
}

/** Persists highlight rules to AppConfig/highlight_settings.json */
async function saveHighlightsToFile(highlights: HighligtConfig[]) {
    try {
        await writeTextFile('highlight_settings.json', JSON.stringify(highlights, null, 2), {
            baseDir: BaseDirectory.AppConfig,
        });
    } catch (e) {
        console.error('Failed to save highlights:', e);
    }
}

const isHighlightSelectMode = (value: unknown): value is HighlightSelectMode =>
    value === 'match' || value === 'whole_line' || value === 'custom';

const getSelectModeFromPersisted = (highlight: PersistedHighlightConfig): HighlightSelectMode => {
    if (isHighlightSelectMode(highlight.select_mode)) return highlight.select_mode;
    if (highlight.whole_line) return 'whole_line';
    return 'match';
};

const normalizeSelectMode = (isRegex: boolean, selectMode: HighlightSelectMode): HighlightSelectMode =>
    (!isRegex && selectMode === 'custom') ? 'match' : selectMode;

/** Parses a persisted JSON config entry into a runtime HighligtConfig, with safe defaults */
function parsePersistedHighlight(h: PersistedHighlightConfig, index: number): HighligtConfig {
    const isRegex = h.is_regex ?? true;
    const color = h.color ?? DEFAULT_HIGHLIGHT_COLOR;
    const selectMode = normalizeSelectMode(isRegex, getSelectModeFromPersisted(h));
    const explicitAdvanced = typeof h.advanced === 'boolean' ? h.advanced : selectMode === 'custom';
    const advancedEnabled = explicitAdvanced && isRegex;
    const persistedAdvancedSelections = (h.advanced_selections ?? []).map((s, si) => ({
        id: s.id ?? Date.now() + index + si,
        color: s.color ?? color,
        selector: s.selector ?? s.custom_select ?? '',
    }));
    return {
        id: h.id ?? Date.now() + index,
        text: h.text ?? '',
        color,
        is_regex: isRegex,
        case_sensitive: h.case_sensitive ?? true,
        whole_line: advancedEnabled ? false : (h.whole_line ?? selectMode === 'whole_line'),
        advanced: advancedEnabled,
        advanced_selections: advancedEnabled
            ? (persistedAdvancedSelections.length > 0
                ? persistedAdvancedSelections
                : [createAdvancedSelection(color, h.custom_select ?? '')])
            : [],
        focus: h.remove ? false : (h.focus ?? true),
        remove: h.remove ?? false,
    };
}

const HighLighSettings: React.FC = () => {
    const [highlights, setHighlights] = useCustomHilightsState();
    const [draggedHighlightId, setDraggedHighlightId] = useState<number | null>(null);
    const [dropIndicator, setDropIndicator] = useState<{ id: number; position: 'before' | 'after' } | null>(null);

    // Load highlights from AppConfig on mount
    useEffect(() => {
        readTextFile('highlight_settings.json', { baseDir: BaseDirectory.AppConfig })
            .then(result => {
                const persisted = JSON.parse(result) as PersistedHighlightConfig[];
                // No refresh for the saved rules: at launch there are no logs yet
                setHighlights(persisted.map(parsePersistedHighlight), { refresh: false });
            })
            .catch(e => console.error('Failed to load highlights:', e));
    }, [setHighlights]);

    // Latest rules, read by the MCP listener without re-subscribing on every change
    const highlightsRef = useRef(highlights);
    useEffect(() => {
        highlightsRef.current = highlights;
    }, [highlights]);

    // Rule added by an MCP client (add_highlight): appended as if the user had filled a new row
    useEffect(() => {
        const unlisten = listen<PersistedHighlightConfig>('mcp-add-highlight', (e) => {
            const rule = parsePersistedHighlight({ ...e.payload, id: createDefaultHighlight().id }, 0);
            // Updated right away so rules added in quick succession are all kept
            const next = [...(highlightsRef.current ?? []), rule];
            highlightsRef.current = next;
            // add_highlight refreshes the logs itself, before returning to the MCP client
            setHighlights(next, { refresh: false });
        });
        return () => { unlisten.then(f => f()); };
    }, [setHighlights]);

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
            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-start', position: 'relative', zIndex: 1, mb: '-42px' }}>
                <IconButton
                    size="medium"
                    title="Load highlight rules from file"
                    onClick={async () => {
                        const filePath = await openDialog({ directory: false, multiple: false, filters: [{ name: 'Highlights', extensions: ['json'] }] }).catch(() => undefined);
                        if (!filePath) return;
                        try {
                            const result = await readTextFile(filePath);
                            const parsed = JSON.parse(result) as PersistedHighlightConfig[];
                            setHighlights(parsed.map(parsePersistedHighlight));
                        } catch (e) {
                            console.error('Failed to load highlights:', e);
                        }
                    }}
                    sx={{ width: 36, height: 36, border: '1px solid #444' }}
                >
                    <FolderOpenIcon fontSize="medium" />
                </IconButton>
                <IconButton
                    size="medium"
                    title="Save highlight rules to file"
                    onClick={async () => {
                        const filePath = await saveDialog({ filters: [{ name: 'Highlights', extensions: ['json'] }] }).catch(() => undefined);
                        if (filePath && highlights) await writeTextFile(filePath, JSON.stringify(highlights, null, 2));
                    }}
                    sx={{ width: 36, height: 36, border: '1px solid #444' }}
                >
                    <SaveIcon fontSize="medium" />
                </IconButton>
            </Box>
            <Box sx={{ overflowX: 'auto', overflowY: 'visible', width: '100%' }}>
                {/* Checkboxes with a smaller padding than the small size (9px) so they fit in the narrow option columns */}
                <Table
                    size="small"
                    sx={{ tableLayout: 'fixed', overflow: 'visible', width: '100%', minWidth: TABLE_MIN_WIDTH, '& .MuiCheckbox-root': { p: 0.75 } }}
                >
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
                            {/* Horizontal padding of the body cell plus the one of the input, so the label lines up with the typed text.
                                Same bottom offset and line height as the rotated option labels, so all the labels sit on the same line */}
                            <TableCell sx={{ verticalAlign: 'bottom', minWidth: SENTENCE_MIN_COLUMN_WIDTH, pl: 0.5, pr: 1, pb: '4px', lineHeight: 1 }}>
                                Search
                            </TableCell>
                            {OPTION_COLUMNS.map((optionColumn) => {
                                return (
                                    <TableCell
                                        key={optionColumn.label}
                                        sx={{
                                            width: optionColumn.width,
                                            minWidth: optionColumn.width,
                                            maxWidth: optionColumn.width,
                                            p: 0,
                                            height: '72px',
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
                                    {/* No left padding so the field touches the drag handle, a bit on the right to keep some space before the color. Little
                                        bottom padding when the advanced row follows, to keep the two rows close */}
                                    <TableCell sx={{ minWidth: SENTENCE_MIN_COLUMN_WIDTH, pl: 0, pr: 1, ...(filter.advanced && { pb: '2px' }) }}>
                                        <TextField
                                            size="small"
                                            placeholder="Filter text"
                                            value={filter.text}
                                            onChange={(e) => handleHighlightChange(filter.id, 'text', e.target.value)}
                                            fullWidth
                                            error={isInvalidRegex(filter.text, filter.is_regex)}
                                            sx={RULE_INPUT_SX}
                                        />
                                    </TableCell>
                                    <TableCell
                                        align="center"
                                        sx={{ width: COLOR_COLUMN_WIDTH, minWidth: COLOR_COLUMN_WIDTH, maxWidth: COLOR_COLUMN_WIDTH, p: 0 }}
                                    >
                                        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                            <ColorPickerButton
                                                value={filter.color.slice(0, 7)}
                                                onChange={(color) => handleHighlightChange(filter.id, 'color', color)}
                                                disabled={filter.remove || filter.advanced}
                                                opacity={filter.advanced ? 0.2 : filter.remove ? 0.45 : 1}
                                            />
                                        </Box>
                                    </TableCell>
                                    <TableCell
                                        align="center"
                                        sx={{ width: CASE_SENSITIVE_COLUMN_WIDTH, minWidth: CASE_SENSITIVE_COLUMN_WIDTH, maxWidth: CASE_SENSITIVE_COLUMN_WIDTH, p: 0 }}
                                    >
                                        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                            <Tooltip title="Case sensitive: Match text with case sensitivity" placement="top" arrow>
                                                <Checkbox
                                                    size="small"
                                                    checked={filter.case_sensitive}
                                                    onChange={(e) => setHighlights(highlights!.map(f => f.id === filter.id ? { ...f, case_sensitive: e.target.checked } : f))}
                                                />
                                            </Tooltip>
                                        </Box>
                                    </TableCell>
                                    <TableCell
                                        align="center"
                                        sx={{ width: REGEX_COLUMN_WIDTH, minWidth: REGEX_COLUMN_WIDTH, maxWidth: REGEX_COLUMN_WIDTH, p: 0 }}
                                    >
                                        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                            <Tooltip title="Regexp: Treat the search as a regular expression" placement="top" arrow>
                                                <Checkbox
                                                    size="small"
                                                    checked={filter.is_regex}
                                                    onChange={(e) => handleHighlightIsRegexChange(filter.id, e.target.checked)}
                                                />
                                            </Tooltip>
                                        </Box>
                                    </TableCell>
                                    <TableCell
                                        align="center"
                                        sx={{ width: FOCUS_COLUMN_WIDTH, minWidth: FOCUS_COLUMN_WIDTH, maxWidth: FOCUS_COLUMN_WIDTH, p: 0 }}
                                    >
                                        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                            <Tooltip title="Focus: Display the whole line in the focus panel" placement="top" arrow>
                                                <span>
                                                    <Checkbox
                                                        size="small"
                                                        checked={filter.focus}
                                                        disabled={filter.remove}
                                                        onChange={(e) => handleHighlightFocusChange(filter.id, e.target.checked)}
                                                    />
                                                </span>
                                            </Tooltip>
                                        </Box>
                                    </TableCell>
                                    <TableCell
                                        align="center"
                                        sx={{ width: REMOVE_COLUMN_WIDTH, minWidth: REMOVE_COLUMN_WIDTH, maxWidth: REMOVE_COLUMN_WIDTH, p: 0 }}
                                    >
                                        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                            <Tooltip title="Remove: Remove the text instead of highlighting it" placement="top" arrow>
                                                <Checkbox
                                                    size="small"
                                                    checked={filter.remove}
                                                    onChange={(e) => handleHighlightRemoveChange(filter.id, e.target.checked)}
                                                />
                                            </Tooltip>
                                        </Box>
                                    </TableCell>
                                    <TableCell
                                        align="center"
                                        sx={{ width: WHOLE_LINE_COLUMN_WIDTH, minWidth: WHOLE_LINE_COLUMN_WIDTH, maxWidth: WHOLE_LINE_COLUMN_WIDTH, p: 0 }}
                                    >
                                        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                            <Tooltip title="Whole line: Highlight or remove the entire line instead of just the matched text" placement="top" arrow>
                                                <span>
                                                    <Checkbox
                                                        size="small"
                                                        checked={filter.whole_line}
                                                        disabled={filter.advanced}
                                                        onChange={(e) => handleHighlightWholeLineChange(filter.id, e.target.checked)}
                                                    />
                                                </span>
                                            </Tooltip>
                                        </Box>
                                    </TableCell>
                                    <TableCell
                                        align="center"
                                        sx={{ width: ADVANCED_COLUMN_WIDTH, minWidth: ADVANCED_COLUMN_WIDTH, maxWidth: ADVANCED_COLUMN_WIDTH, p: 0 }}
                                    >
                                        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                            <Tooltip title="Advanced: Enable advanced mode to colorize individual regex capture groups with different colors (requires regex)" placement="top" arrow>
                                                <span>
                                                    <Checkbox
                                                        size="small"
                                                        checked={filter.advanced}
                                                        disabled={!filter.is_regex}
                                                        onChange={(e) => handleHighlightAdvancedChange(filter.id, e.target.checked)}
                                                    />
                                                </span>
                                            </Tooltip>
                                        </Box>
                                    </TableCell>
                                    <TableCell
                                        align="center"
                                        sx={{ width: ACTION_COLUMN_WIDTH, minWidth: ACTION_COLUMN_WIDTH, maxWidth: ACTION_COLUMN_WIDTH, p: 0 }}
                                    >
                                        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                            <Tooltip title="Delete this rule" placement="top" arrow>
                                                <IconButton size="small" sx={{ p: 0.5 }} onClick={() => handleRemoveHighlight(filter.id)}>
                                                    <DeleteIcon />
                                                </IconButton>
                                            </Tooltip>
                                        </Box>
                                    </TableCell>
                                </TableRow>

                                {filter.advanced && (
                                    <TableRow
                                        onDragOver={handleDragOverRow(filter.id)}
                                        onDrop={handleDropOnRow(filter.id)}
                                        sx={{ opacity: draggedHighlightId === filter.id ? 0.6 : 1 }}
                                    >
                                        <TableCell
                                            sx={{
                                                width: DRAG_COLUMN_WIDTH,
                                                minWidth: DRAG_COLUMN_WIDTH,
                                                maxWidth: DRAG_COLUMN_WIDTH,
                                                p: 0,
                                                borderBottom: 'none',
                                            }}
                                        />
                                        <TableCell
                                            colSpan={8}
                                            sx={{ p: 0.5, pt: 0, pl: 4 }}
                                        >
                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                                                <SubdirectoryArrowRightIcon sx={{ color: 'text.disabled', fontSize: '1.1rem', mr: 0.5 }} />
                                                {filter.advanced_selections.map((selection) => (
                                                    <Box
                                                        key={selection.id}
                                                        sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}
                                                    >
                                                        <ColorPickerButton
                                                            value={selection.color.slice(0, 7)}
                                                            onChange={(color) => handleAdvancedSelectionChange(filter.id, selection.id, 'color', color)}
                                                            disabled={filter.remove}
                                                            opacity={filter.remove ? 0.45 : 1}
                                                        />
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
                                                                    error={hasInvalidGroup(selection.selector, filter.text)}
                                                                    sx={{ width: 55, ...RULE_INPUT_SX }}
                                                                />
                                                            </span>
                                                        </Tooltip>
                                                        {filter.advanced_selections.length > 1 && (
                                                            <IconButton
                                                                size="small"
                                                                sx={{ p: 0.25 }}
                                                                onClick={() => handleRemoveAdvancedSelection(filter.id, selection.id)}
                                                            >
                                                                <DeleteIcon fontSize="small" />
                                                            </IconButton>
                                                        )}
                                                    </Box>
                                                ))}
                                                <IconButton
                                                    size="small"
                                                    sx={{ p: 0.5 }}
                                                    onClick={() => handleAddAdvancedSelection(filter.id)}
                                                >
                                                    <AddIcon fontSize="small" />
                                                </IconButton>
                                            </Box>
                                        </TableCell>
                                    </TableRow>
                                )}
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

