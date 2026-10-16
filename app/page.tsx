'use client';

import React, { useState, useRef, useEffect, type SyntheticEvent } from 'react';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import { Resizable } from 're-resizable';
import type { ListImperativeAPI } from 'react-window';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import BookmarkAddOutlinedIcon from '@mui/icons-material/BookmarkAddOutlined';
import SaveIcon from '@mui/icons-material/Save';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import LastPageIcon from '@mui/icons-material/LastPage';
import FirstPageIcon from '@mui/icons-material/FirstPage';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import ControlPanel from './components/ControlPanel';
import SearchBar from './components/SearchBar';
import { useLogSearch } from './hooks/useLogSearch';
import SerialTerminal, { type Arrival, type LineNumbers, type Timestamps } from './components/SerialTerminal';
import { formatTimestamp, isTimestampShown, timestampColumnText, timestampWidth } from './utils/timestamp';
import { useAppConfig } from './hooks/useAppConfig';
import { SerialMessage } from './types/SerialMessage';

// Shared timestamp for demo log generation — reset on each regenerate call
let demoTime = 0;

const darkTheme = createTheme({
  palette: { mode: 'dark' },
  typography: { button: { textTransform: 'none' } },
});

/** Generates synthetic UART-style log lines for demo purposes */
const scrollToRow = (listRef: React.RefObject<ListImperativeAPI>, rowIndex: number, behavior: 'auto' | 'smooth' = 'smooth') => {
  listRef.current?.scrollToRow({ align: 'end', behavior, index: rowIndex });
};

// Ids increase along the log, so a line is found by binary search. Falls back to a linear
// search in case lines from concurrent sources were appended out of id order.
const findLogIndex = (lines: SerialMessage[], id: number): number => {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    let middle = (low + high) >> 1;
    // A marker inserted in the middle of the log has a larger id than the lines around it, so
    // the next line that is not a marker is compared instead
    while (middle < high && lines[middle].marker && lines[middle].id !== id) middle++;
    if (lines[middle].id === id) return middle;
    if (lines[middle].id < id) low = middle + 1;
    else high = middle - 1;
  }
  return lines.findIndex(line => line.id === id);
};

// Copy of `lines` with `line` inserted at `index`
const insertAt = (lines: SerialMessage[], index: number, line: SerialMessage): SerialMessage[] =>
  [...lines.slice(0, index), line, ...lines.slice(index)];

const generateDemoLogs = (count: number): string[] => {
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    demoTime += Math.random() * 0.1;
    const timestamp = `[${demoTime.toFixed(6)}]`;
    const type = Math.random();
    let message: string;
    if (type < 0.1) {
      message = `ERROR: Connection timeout at address 0x${Math.floor(Math.random() * 0xffff).toString(16)}                                                                                                        00000000`;
    } else if (type < 0.3) {
      message = `WARN: Retrying packet ${i}...                                                                                                          00000000`;
    } else if (type < 0.6) {
      message = `INFO: Received packet len=${Math.floor(Math.random() * 100)} flags=0x${Math.floor(Math.random() * 0xff).toString(16)}                                                                                                          00000000`;
    } else {
      message = `DEBUG: Processing data chunk ${i} state=${Math.floor(Math.random() * 5)}`;
    }
    result.push(`${timestamp} ${message}`);
  }
  return result;
};

export default function Home() {
  const listRefMain = useRef<ListImperativeAPI>(null!);
  const listRefFocus = useRef<ListImperativeAPI>(null!);
  const ignoreMainScrollUntilRef = useRef(0);
  const ignoreFocusScrollUntilRef = useRef(0);

  const [config, updateConfig] = useAppConfig();
  const [logs, setLogs] = useState<SerialMessage[]>([]);
  const [focusLogs, setFocusLogs] = useState<SerialMessage[]>([]);
  const [selectedMainLineId, setSelectedMainLineId] = useState<number | null>(null);
  const [isMainAutoScrollEnabled, setIsMainAutoScrollEnabled] = useState(true);
  const [isFocusAutoScrollEnabled, setIsFocusAutoScrollEnabled] = useState(true);
  const [isSettingsPanelOpen, setIsSettingsPanelOpen] = useState(true);
  const [isFocusPanelOpen, setIsFocusPanelOpen] = useState(true);
  const [mainMenuAnchor, setMainMenuAnchor] = useState<null | HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Scrolls the main terminal to a search match; auto-scroll is turned off so new lines do not
  // pull the view away from it
  const revealMainLine = (line: number) => {
    setIsMainAutoScrollEnabled(false);
    ignoreMainScrollUntilRef.current = Date.now() + 250;
    listRefMain.current?.scrollToRow({ align: 'center', behavior: 'auto', index: line });
  };
  const search = useLogSearch(logs, revealMainLine);
  const openSearch = search.open;

  // Demo: send a batch of generated lines to the backend for processing and append
  const appendLogs = (count: number) => {
    invoke<void>('append_logs_line', { lines: generateDemoLogs(count) })
      .catch((err: unknown) => console.error(err));
  };

  // Demo: reset and send a small batch through the backend (replaces current logs)
  const regenerateLogs = () => {
    demoTime = 0;
    invoke<void>('add_logs_line', { lines: generateDemoLogs(10) })
      .catch((err: unknown) => console.error(err));
  };

  const clearLogs = () => setLogs([]);
  const clearFocusLogs = () => setFocusLogs([]);

  // User clear: also empties the backend log store, so MCP clients see the same log
  const onClearLogs = () => {
    clearLogs();
    invoke<void>('clear_logs').catch((err: unknown) => console.error(err));
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        setLogs([]);
        setFocusLogs([]);
        invoke<void>('clear_logs').catch((err: unknown) => console.error(err));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Ctrl+F opens the search bar, or selects its text when it is already open
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openSearch();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openSearch]);

  // Ctrl+M appends a marker line, e.g. to delimit a reproduction attempt
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        invoke<void>('add_marker').catch((err: unknown) => console.error(err));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Inserts a marker just above a line of the main log, with the timestamp of the line above it
  // (none for the first line). In the focus log, it goes after the closest focus line above it,
  // or else before the closest focus line below it
  const insertMarkerAbove = (lineId: number) => {
    const index = findLogIndex(logs, lineId);
    if (index < 0) return;
    let focusAboveId: number | undefined;
    for (let i = index - 1; i >= 0 && focusAboveId === undefined; i--) {
      if (logs[i].matched) focusAboveId = logs[i].id;
    }
    let focusBelowId: number | undefined;
    for (let i = index; i < logs.length && focusAboveId === undefined && focusBelowId === undefined; i++) {
      if (logs[i].matched) focusBelowId = logs[i].id;
    }
    const timestamp = index > 0 ? logs[index - 1].timestamp ?? null : null;
    invoke<SerialMessage>('insert_marker', { beforeId: lineId, timestamp })
      .then((payload) => {
        const marker = { ...payload, arrivedAt: Date.now() };
        // Positions are looked up again, the logs may have changed meanwhile
        setLogs(prev => {
          const at = findLogIndex(prev, lineId);
          return at < 0 ? prev : insertAt(prev, at, marker);
        });
        setFocusLogs(prev => {
          const above = focusAboveId === undefined ? -1 : prev.findIndex(line => line.id === focusAboveId);
          if (above >= 0) return insertAt(prev, above + 1, marker);
          const below = focusBelowId === undefined ? -1 : prev.findIndex(line => line.id === focusBelowId);
          return insertAt(prev, below >= 0 ? below : prev.length, marker);
        });
      })
      .catch((err: unknown) => console.error(err));
  };

  // Click on a focus row: scroll the main terminal to the matching line and highlight it
  const onClickFocusLogs = (id: number) => {
    const index = logs.findIndex(log => log.id === id);
    if (index !== -1) {
      listRefMain.current?.scrollToRow({ align: 'center', behavior: 'smooth', index });
      setSelectedMainLineId(prev => prev === id ? null : id);
    }
  };

  // Line numbers are positions in the main log; a focus line shows the number of the same
  // line in the main log. The gutter width follows the largest number.
  const lineNumberDigits = String(logs.length).length;
  const mainLineNumbers: LineNumbers | undefined = config.showLineNumbers
    ? { numberOf: (index) => index + 1, digits: lineNumberDigits }
    : undefined;
  const focusLineNumbers: LineNumbers | undefined = config.showLineNumbers
    ? {
      numberOf: (index) => {
        const mainIndex = findLogIndex(logs, focusLogs[index].id);
        return mainIndex < 0 ? undefined : mainIndex + 1;
      },
      digits: lineNumberDigits,
    }
    : undefined;

  const arrival: Arrival | undefined = config.highlightNewLines
    ? { durationMs: config.newLineHighlightMs, color: config.newLineHighlightColor }
    : undefined;

  const timestamps: Timestamps | undefined = config.showTimestamps
    ? {
      inText: config.timestampsInText,
      inactivityMs: config.timestampsAfterInactivityOnly ? config.timestampInactivityMs : undefined,
      format: config.timestampFormat,
      width: timestampWidth(config.timestampFormat),
    }
    : undefined;

  // Text written by Save: the raw line, prefixed with the timestamp column when timestamps are
  // part of the text (blanks when the line shows no timestamp), as on screen
  const savedLineText = (lines: SerialMessage[], index: number) => {
    const msg = lines[index];
    const text = msg.rawline ?? msg.message;
    if (!timestamps?.inText) return text;
    const timestamp = msg.timestamp != null && isTimestampShown(lines, index, timestamps.inactivityMs)
      ? formatTimestamp(msg.timestamp, timestamps.format)
      : '';
    return timestampColumnText(timestamp, timestamps.width) + text;
  };

  // Re-apply current highlight rules to all existing raw lines
  const onClickRefreshAll = () => {
    const rawLines = logs.map(log => log.rawline ?? log.message);
    clearFocusLogs();
    clearLogs();
    // Reception times and markers are sent back so reprocessed lines keep them
    const timestamps = logs.map(log => log.timestamp ?? null);
    const markers = logs.map(log => log.marker ?? false);
    invoke<void>('add_logs_line', { lines: rawLines, timestamps, markers })
      .catch((err: unknown) => console.error(err));
  };

  const addSingleLog = (log: SerialMessage) => {
    setLogs(prev => [...prev, log]);
  };

  const addSingleFocusLog = (log: SerialMessage) => {
    setFocusLogs(prev => [...prev, log]);
  };
  useEffect(() => {
    if (isMainAutoScrollEnabled && listRefMain.current && logs.length > 0) {
      scrollToRow(listRefMain, logs.length - 1, 'auto');
    }

    if (isFocusAutoScrollEnabled && listRefFocus.current && focusLogs.length > 0) {
      scrollToRow(listRefFocus, focusLogs.length - 1, 'auto');
    }
  }, [logs, focusLogs, isMainAutoScrollEnabled, isFocusAutoScrollEnabled]);

  useEffect(() => {
    // Appended lines are stamped with their arrival time for the new line highlight; lines
    // replacing the whole log (file open, Refresh) are not
    const unlisten_serial_data = listen<SerialMessage>('serial-data', (e) => {
      const line = { ...e.payload, arrivedAt: Date.now() };
      addSingleLog(line);
      if (line.matched) addSingleFocusLog(line);
    });
    const unlisten_serial_datas = listen<SerialMessage[]>('serial-datas', (e) => {
      setLogs(e.payload);
    });
    const unlisten_serial_datas_focus = listen<SerialMessage[]>('serial-datas-focus', (e) => {
      setFocusLogs(e.payload);
    });
    const unlisten_serial_datas_append = listen<SerialMessage[]>('serial-datas-append', (e) => {
      const arrivedAt = Date.now();
      setLogs(prev => [...prev, ...e.payload.map(line => ({ ...line, arrivedAt }))]);
    });
    const unlisten_serial_datas_focus_append = listen<SerialMessage[]>('serial-datas-focus-append', (e) => {
      const arrivedAt = Date.now();
      setFocusLogs(prev => [...prev, ...e.payload.map(line => ({ ...line, arrivedAt }))]);
    });
    // Emitted when an MCP client calls clear_logs, so the window stays in sync
    // with what the agent just did to the shared buffer.
    const unlisten_logs_cleared = listen('logs-cleared', () => {
      clearLogs();
      clearFocusLogs();
    });

    return () => {
      unlisten_serial_data.then(f => f());
      unlisten_serial_datas.then(f => f());
      unlisten_serial_datas_focus.then(f => f());
      unlisten_serial_datas_append.then(f => f());
      unlisten_serial_datas_focus_append.then(f => f());
      unlisten_logs_cleared.then(f => f());
    };
  }, []);




  const onToggleAutoScrollFromLogs = () => {
    setIsMainAutoScrollEnabled((prev) => {
      const next = !prev;
      if (next) {
        ignoreMainScrollUntilRef.current = Date.now() + 250;
        if (logs.length > 0) {
          scrollToRow(listRefMain, logs.length - 1, 'auto');
        }
      }
      return next;
    });
  };

  const onToggleAutoScrollFromFocus = () => {
    setIsFocusAutoScrollEnabled((prev) => {
      const next = !prev;
      if (next) {
        ignoreFocusScrollUntilRef.current = Date.now() + 250;
        if (focusLogs.length > 0) {
          scrollToRow(listRefFocus, focusLogs.length - 1, 'auto');
        }
      }
      return next;
    });
  };

  const handleScroll = (
    event: SyntheticEvent<HTMLDivElement>,
    isAutoScrollEnabled: boolean,
    setIsAutoScrollEnabled: React.Dispatch<React.SetStateAction<boolean>>,
    ignoreScrollUntilRef: React.MutableRefObject<number>
  ) => {
    if (Date.now() < ignoreScrollUntilRef.current || event.nativeEvent == null) return;
    const target = event.nativeEvent.target as HTMLDivElement;
    const diff = target.scrollHeight - target.clientHeight - target.scrollTop;
    if (diff === 0 && !isAutoScrollEnabled) {
      setIsAutoScrollEnabled(true);
    } else if (diff > 30 && isAutoScrollEnabled) {
      setIsAutoScrollEnabled(false);
    }
  };

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
        {/* Horizontal Container */}
        <Container disableGutters maxWidth={false} sx={{ py: 0, height: '100vh', width:'100%', display:'flex', flexDirection: 'row', pl:0, pr:0, overflow: 'hidden' }}>
          {/* Terminals area — fills all remaining space */}
          <Box sx={{ flex: 1, minWidth: 0, height: '100%', position: 'relative' }}>
            {/* Toggle button straddling right border, vertically centered */}
            <IconButton
              size="medium"
              onClick={() => setIsSettingsPanelOpen(v => !v)}
              title={isSettingsPanelOpen ? 'Collapse settings' : 'Expand settings'}
              sx={{
                position: 'absolute',
                top: '50%',
                right: -18,
                transform: 'translateY(-50%)',
                zIndex: 10,
                width: 36,
                height: 36,
                bgcolor: 'background.paper',
                border: '1px solid #444',
                borderRadius: '50%',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              {isSettingsPanelOpen ? <LastPageIcon fontSize="medium" /> : <FirstPageIcon fontSize="medium" />}
            </IconButton>
            {/* Content with overflow clipping */}
            <Box sx={{ height: '100%', overflow: 'hidden' }}>
            {/* Serial vertical Container */}
            <Container disableGutters maxWidth={false} sx={{ py: 0, height: '100%', width:'100%', display:'flex', flexDirection: 'column', pl:0, pr:0, overflow: 'hidden' }}>
              {/* Main Serial Terminal — wrapper takes remaining space when focus closed */}
              <Box sx={isFocusPanelOpen
                ? { display: 'contents' }
                : { flex: 1, minHeight: 0, overflow: 'hidden' }
              }>
              <Resizable
                minWidth='100%'
                maxWidth='100%'
                maxHeight={isFocusPanelOpen ? '90%' : '100%'}
                enable={{ bottom: isFocusPanelOpen, top: false, left: false, right: false, topLeft: false, topRight: false, bottomLeft: false, bottomRight: false }}
                {...(!isFocusPanelOpen && { size: { width: '100%', height: '100%' } })}
                defaultSize={{
                  width: '100%',
                  height: '70%',
                }}
                >
                <Box sx={{ height: '100%', position: 'relative' }}>
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 10,
                      right: 28,
                      zIndex: 2,
                      display: 'flex',
                      gap: 1,
                    }}
                  >
                    <Tooltip title="Search (Ctrl+F)" placement="top" arrow>
                    <IconButton
                      aria-label="search"
                      aria-pressed={search.isOpen}
                      size="medium"
                      color="inherit"
                      onClick={search.isOpen ? search.close : search.open}
                      sx={{
                        width: 36,
                        height: 36,
                        border: '1px solid #333',
                        bgcolor: search.isOpen ? 'rgba(33, 150, 243, 0.28)' : 'rgba(30, 30, 30, 0.75)',
                        '&:hover': {
                          bgcolor: search.isOpen ? 'rgba(33, 150, 243, 0.42)' : 'rgba(30, 30, 30, 0.95)',
                        },
                      }}
                    >
                      <SearchIcon fontSize="medium" />
                    </IconButton>
                    </Tooltip>
                    <Tooltip title="Auto-scroll" placement="top" arrow>
                    <IconButton
                      aria-label="toggle auto-scroll"
                      aria-pressed={isMainAutoScrollEnabled}
                      size="medium"
                      color="inherit"
                      onClick={onToggleAutoScrollFromLogs}
                      sx={{
                        width: 36,
                        height: 36,
                        border: '1px solid #333',
                        bgcolor: isMainAutoScrollEnabled ? 'rgba(33, 150, 243, 0.28)' : 'rgba(30, 30, 30, 0.75)',
                        '&:hover': {
                          bgcolor: isMainAutoScrollEnabled ? 'rgba(33, 150, 243, 0.42)' : 'rgba(30, 30, 30, 0.95)',
                        },
                      }}
                    >
                      <KeyboardArrowDownIcon fontSize="medium" />
                    </IconButton>
                    </Tooltip>
                    <Tooltip title="Apply current highlight rules to all logs (Usefull when rules have changed)" placement="top" arrow>
                    <IconButton
                      aria-label="refresh logs"
                      size="medium"
                      color="inherit"
                      onClick={onClickRefreshAll}
                      sx={{
                        width: 36,
                        height: 36,
                        border: '1px solid #333',
                        bgcolor: 'rgba(30, 30, 30, 0.75)',
                        '&:hover': {
                          bgcolor: 'rgba(30, 30, 30, 0.95)',
                        },
                      }}
                    >
                      <RefreshIcon fontSize="medium" />
                    </IconButton>
                    </Tooltip>
                    <Tooltip title="Insert a marker (Ctrl+M)" placement="top" arrow>
                    <IconButton
                      aria-label="insert marker"
                      size="medium"
                      color="inherit"
                      onClick={() => invoke<void>('add_marker').catch((err: unknown) => console.error(err))}
                      sx={{
                        width: 36,
                        height: 36,
                        border: '1px solid #333',
                        bgcolor: 'rgba(30, 30, 30, 0.75)',
                        '&:hover': {
                          bgcolor: 'rgba(30, 30, 30, 0.95)',
                        },
                      }}
                    >
                      <BookmarkAddOutlinedIcon fontSize="medium" />
                    </IconButton>
                    </Tooltip>
                    <Tooltip title="Save logs to file" placement="top" arrow>
                    <IconButton
                      aria-label="save logs to file"
                      size="medium"
                      color="inherit"
                      onClick={async () => {
                        let buf = '';
                        for (let index = 0; index < logs.length; index++) {
                          buf += savedLineText(logs, index) + '\n';
                        }
                        const filePath = await save({ filters: [{ name: 'export', extensions: ['log'] }] }).catch(() => undefined);
                        if (filePath) await writeTextFile(filePath, buf);
                      }}
                      sx={{
                        width: 36,
                        height: 36,
                        border: '1px solid #333',
                        bgcolor: 'rgba(30, 30, 30, 0.75)',
                        '&:hover': {
                          bgcolor: 'rgba(30, 30, 30, 0.95)',
                        },
                      }}
                    >
                      <SaveIcon fontSize="medium" />
                    </IconButton>
                    </Tooltip>
                  <Tooltip title="Clear logs (Ctrl+Shift+R)" placement="top" arrow>
                  <IconButton
                    aria-label="clear logs"
                    size="medium"
                    color="inherit"
                    onClick={onClearLogs}
                    sx={{
                      width: 36,
                      height: 36,
                      border: '1px solid #333',
                      bgcolor: 'rgba(30, 30, 30, 0.75)',
                      '&:hover': {
                        bgcolor: 'rgba(30, 30, 30, 0.95)',
                      },
                    }}
                  >
                    <DeleteOutlineIcon fontSize="medium" />
                  </IconButton>
                  </Tooltip>
                    <Tooltip title="More options" placement="top" arrow>
                    <IconButton
                      aria-label="more options"
                      size="medium"
                      color="inherit"
                      onClick={(e) => setMainMenuAnchor(e.currentTarget)}
                      sx={{
                        width: 36,
                        height: 36,
                        border: '1px solid #333',
                        bgcolor: 'rgba(30, 30, 30, 0.75)',
                        '&:hover': { bgcolor: 'rgba(30, 30, 30, 0.95)' },
                      }}
                    >
                      <MoreVertIcon fontSize="medium" />
                    </IconButton>
                    </Tooltip>
                    <Menu
                      anchorEl={mainMenuAnchor}
                      open={Boolean(mainMenuAnchor)}
                      onClose={() => setMainMenuAnchor(null)}
                      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                    >
                      <MenuItem onClick={() => { appendLogs(10000); setMainMenuAnchor(null); }}>Demo - Append 10k logs</MenuItem>
                      <MenuItem onClick={() => { regenerateLogs(); setMainMenuAnchor(null); }}>Demo - Clear and add 10 logs</MenuItem>
                    </Menu>
                  </Box>
                  {search.isOpen && (
                    <Box sx={{ position: 'absolute', top: 54, right: 28, zIndex: 2 }}>
                      <SearchBar search={search} inputRef={searchInputRef} />
                    </Box>
                  )}
                  <SerialTerminal
                    serial_messages={logs}
                    listRef={listRefMain}
                    onScroll={(event) => handleScroll(event, isMainAutoScrollEnabled, setIsMainAutoScrollEnabled, ignoreMainScrollUntilRef)}
                    selectedLineId={selectedMainLineId}
                    onClickRow={(id) => setSelectedMainLineId(prev => prev === id ? null : id)}
                    onInsertMarker={insertMarkerAbove}
                    lineNumbers={mainLineNumbers}
                    timestamps={timestamps}
                    arrival={arrival}
                    search={search.isOpen && search.regex
                      ? { regex: search.regex, current: search.matches[search.currentIndex] }
                      : undefined}
                  />
                </Box>
              </Resizable>
              </Box>
              {/* Focus Serial Terminal */}
              <Box sx={{ position: 'relative', flexShrink: 0 }}>
                {/* Toggle button straddling top border, horizontally centered */}
                <IconButton
                  size="medium"
                  onClick={() => setIsFocusPanelOpen(v => !v)}
                  title={isFocusPanelOpen ? 'Collapse focus' : 'Expand focus'}
                  sx={{
                    position: 'absolute',
                    left: '50%',
                    top: -18,
                    transform: 'translateX(-50%)',
                    zIndex: 10,
                    width: 36,
                    height: 36,
                    bgcolor: 'background.paper',
                    border: '1px solid #444',
                    borderRadius: '50%',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  {isFocusPanelOpen ? <LastPageIcon fontSize="medium" sx={{ transform: 'rotate(90deg)' }} /> : <FirstPageIcon fontSize="medium" sx={{ transform: 'rotate(90deg)' }} />}
                </IconButton>
                <Typography
                  component="span"
                  sx={{
                    display: 'block',
                    fontFamily: 'monospace',
                    fontSize: '0.875rem',
                    color: '#d4d4d4',
                    lineHeight: 1.2,
                    borderTop: '1px solid #333',
                    pt: 0.5,
                    pl: 1,
                  }}
                >
                  {"focus"}
                </Typography>
              </Box>
              {isFocusPanelOpen && (
              <Box sx={{ flexGrow: 1, minHeight: '10%', position: 'relative' }}>
                <Box
                  sx={{
                    position: 'absolute',
                    top: 10,
                    right: 28,
                    zIndex: 2,
                    display: 'flex',
                    gap: 1,
                  }}
                >
                  <Tooltip title="Auto-scroll" placement="top" arrow>
                  <IconButton
                    aria-label="toggle focus auto-scroll"
                    aria-pressed={isFocusAutoScrollEnabled}
                    size="medium"
                    color="inherit"
                    onClick={onToggleAutoScrollFromFocus}
                    sx={{
                      width: 36,
                      height: 36,
                      border: '1px solid #333',
                      bgcolor: isFocusAutoScrollEnabled ? 'rgba(33, 150, 243, 0.28)' : 'rgba(30, 30, 30, 0.75)',
                      '&:hover': {
                        bgcolor: isFocusAutoScrollEnabled ? 'rgba(33, 150, 243, 0.42)' : 'rgba(30, 30, 30, 0.95)',
                      },
                    }}
                  >
                    <KeyboardArrowDownIcon fontSize="medium" />
                  </IconButton>
                  </Tooltip>
                  <Tooltip title="Save focus logs to file" placement="top" arrow>
                  <IconButton
                    aria-label="save focus logs to file"
                    size="medium"
                    color="inherit"
                    onClick={async () => {
                      let buf = '';
                      for (let index = 0; index < focusLogs.length; index++) {
                        buf += savedLineText(focusLogs, index) + '\n';
                      }
                      const filePath = await save({ filters: [{ name: 'export', extensions: ['log'] }] }).catch(() => undefined);
                      if (filePath) await writeTextFile(filePath, buf);
                    }}
                    sx={{
                      width: 36,
                      height: 36,
                      border: '1px solid #333',
                      bgcolor: 'rgba(30, 30, 30, 0.75)',
                      '&:hover': {
                        bgcolor: 'rgba(30, 30, 30, 0.95)',
                      },
                    }}
                  >
                    <SaveIcon fontSize="medium" />
                  </IconButton>
                  </Tooltip>
                  <Tooltip title="Clear focus logs (Ctrl+Shift+R)" placement="top" arrow>
                  <IconButton
                    aria-label="clear focus logs"
                    size="medium"
                    color="inherit"
                    onClick={clearFocusLogs}
                    sx={{
                      width: 36,
                      height: 36,
                      border: '1px solid #333',
                      bgcolor: 'rgba(30, 30, 30, 0.75)',
                      '&:hover': {
                        bgcolor: 'rgba(30, 30, 30, 0.95)',
                      },
                    }}
                  >
                    <DeleteOutlineIcon fontSize="medium" />
                  </IconButton>
                  </Tooltip>
                </Box>
                <SerialTerminal
                  serial_messages={focusLogs}
                  listRef={listRefFocus}
                  onScroll={(event) => handleScroll(event, isFocusAutoScrollEnabled, setIsFocusAutoScrollEnabled, ignoreFocusScrollUntilRef)}
                  onClickRow={onClickFocusLogs}
                  lineNumbers={focusLineNumbers}
                  timestamps={timestamps}
                  arrival={arrival}
                />
              </Box>
              )}
            </Container>
            </Box>
          </Box>

          {/* Settings panel — always mounted to preserve connection state */}
          <Resizable
            enable={{ left: isSettingsPanelOpen, top: false, right: false, bottom: false, topLeft: false, topRight: false, bottomLeft: false, bottomRight: false }}
            minWidth={isSettingsPanelOpen ? 220 : 36}
            maxWidth={isSettingsPanelOpen ? '70%' : 36}
            size={isSettingsPanelOpen ? undefined : { width: 36, height: '100%' }}
            defaultSize={{ width: '30%', height: '100%' }}
            style={{ height: '100%', borderLeft: '1px solid #333', display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}
          >
            {/* ControlPanel: always mounted, hidden when panel is collapsed */}
            <Box sx={{ flex: 1, overflow: 'hidden', display: isSettingsPanelOpen ? 'flex' : 'none', flexDirection: 'column' }}>
              <ControlPanel config={config} onConfigChange={updateConfig} />
            </Box>
            {/* Collapsed strip: vertical "Settings" label */}
            {!isSettingsPanelOpen && (
              <Box
                sx={{
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  pt: 5,
                  px: 1,
                }}
              >
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
                  {'Settings'.split('').map((char, i) => (
                    <Typography key={i} sx={{ fontSize: '0.875rem', color: 'text.secondary', letterSpacing: 0, userSelect: 'none', lineHeight: 1.3 }}>
                      {char}
                    </Typography>
                  ))}
                </Box>
              </Box>
            )}
          </Resizable>
        </Container>
    </ThemeProvider>
  );
}
