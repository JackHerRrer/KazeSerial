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
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import ControlPanel from './components/ControlPanel';
import ToolbarButton from './components/ToolbarButton';
import SearchBar from './components/SearchBar';
import SendBar from './components/SendBar';
import { useLogSearch } from './hooks/useLogSearch';
import SerialTerminal, { type Arrival, type LineNumbers, type Timestamps } from './components/SerialTerminal';
import { MINIMAP_WIDTH } from './components/LogMinimap';
import { formatTimestamp, isTimestampShown, timestampColumnText, timestampWidth } from './utils/timestamp';
import { useAppConfig } from './hooks/useAppConfig';
import { useTerminalRows } from './hooks/useTerminalRows';
import { SerialMessage } from './types/SerialMessage';

// Shared timestamp for demo log generation — reset on each regenerate call
let demoTime = 0;

const darkTheme = createTheme({
  palette: { mode: 'dark' },
  typography: { button: { textTransform: 'none' } },
});

// Scrolls the list so that row `rowIndex` is at its bottom
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

// Appends a numbered marker line, e.g. to delimit a reproduction attempt
const addMarker = () => {
  invoke<void>('add_marker').catch((err: unknown) => console.error(err));
};

/**
 * Updates of a list of lines. Appended lines are applied once per frame: copying the whole list
 * for each line received would make receiving a long log quadratic, and render the page for each
 * line. Replacing the list drops the lines still waiting to be appended.
 */
const createLineList = (setLines: React.Dispatch<React.SetStateAction<SerialMessage[]>>) => {
  let pending: SerialMessage[] = [];
  let frame = 0;
  return {
    append(lines: SerialMessage[]) {
      pending.push(...lines);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const batch = pending;
        pending = [];
        setLines(prev => prev.concat(batch));
      });
    },
    replace(lines: SerialMessage[]) {
      pending = [];
      cancelAnimationFrame(frame);
      frame = 0;
      setLines(lines);
    },
  };
};

/** Generates synthetic UART-style log lines for demo purposes */
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
  const [mainList] = useState(() => createLineList(setLogs));
  const [focusList] = useState(() => createLineList(setFocusLogs));
  const mainRows = useTerminalRows(logs);
  const focusRows = useTerminalRows(focusLogs);
  const [selectedMainLineId, setSelectedMainLineId] = useState<number | null>(null);
  const [isMainAutoScrollEnabled, setIsMainAutoScrollEnabled] = useState(true);
  const [isFocusAutoScrollEnabled, setIsFocusAutoScrollEnabled] = useState(true);
  const [isSettingsPanelOpen, setIsSettingsPanelOpen] = useState(true);
  const [isFocusPanelOpen, setIsFocusPanelOpen] = useState(true);
  const [mainMenuAnchor, setMainMenuAnchor] = useState<null | HTMLElement>(null);
  // The serial port is open, so text can be sent to it
  const [isSerialConnected, setIsSerialConnected] = useState(false);
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

  const clearLogs = () => mainList.replace([]);
  const clearFocusLogs = () => focusList.replace([]);

  // User clear: also empties the backend log store, so MCP clients see the same log
  const onClearLogs = () => {
    clearLogs();
    invoke<void>('clear_logs').catch((err: unknown) => console.error(err));
  };

  // Keyboard shortcuts: Ctrl+Shift+R clears the main and focus logs, Ctrl+F opens the search bar
  // (or selects its text when it is already open), Ctrl+M appends a marker
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === 'r') {
        mainList.replace([]);
        focusList.replace([]);
        invoke<void>('clear_logs').catch((err: unknown) => console.error(err));
      } else if (!e.shiftKey && key === 'f') {
        openSearch();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (!e.shiftKey && key === 'm') {
        addMarker();
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openSearch, mainList, focusList]);

  // Log files are written by the backend, which gets their settings at launch and on every
  // change. Lines are written as Save writes them, so it also gets the timestamp settings.
  const { logFileEnabled, logFileFolder, logFileRotation, logFileMaxFiles, logFileMaxLines } = config;
  const { showTimestamps, timestampsInText, timestampFormat, timestampsAfterInactivityOnly, timestampInactivityMs } = config;
  useEffect(() => {
    const settings = {
      enabled: logFileEnabled,
      folder: logFileFolder || null,
      rotation: logFileRotation,
      maxFiles: logFileMaxFiles,
      maxLines: logFileMaxLines,
      timestampsInText: showTimestamps && timestampsInText,
      timestampFormat,
      inactivityMs: timestampsAfterInactivityOnly ? timestampInactivityMs : null,
    };
    invoke<void>('set_log_file_settings', { settings }).catch((err: unknown) => console.error(err));
  }, [logFileEnabled, logFileFolder, logFileRotation, logFileMaxFiles, logFileMaxLines,
    showTimestamps, timestampsInText, timestampFormat, timestampsAfterInactivityOnly, timestampInactivityMs]);

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
        // Positions are looked up again, the logs may have changed meanwhile. A Refresh may
        // already have shown the marker, as it reads the lines from the backend
        const isShown = (lines: SerialMessage[]) => lines.some(line => line.id === marker.id);
        setLogs(prev => {
          const at = findLogIndex(prev, lineId);
          return at < 0 || isShown(prev) ? prev : insertAt(prev, at, marker);
        });
        setFocusLogs(prev => {
          if (isShown(prev)) return prev;
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
    const index = findLogIndex(logs, id);
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

  // Save: writes `lines` as shown to a file chosen by the user
  const saveLines = async (lines: SerialMessage[]) => {
    const text = lines.map((_, index) => savedLineText(lines, index) + '\n').join('');
    const filePath = await save({ filters: [{ name: 'export', extensions: ['log'] }] }).catch(() => undefined);
    if (filePath) await writeTextFile(filePath, text);
  };

  // Re-apply current highlight rules to all lines: the backend reprocesses the lines it recorded
  // and replaces the logs, without losing the lines received meanwhile
  const onClickRefreshAll = () => {
    invoke<void>('refresh_logs').catch((err: unknown) => console.error(err));
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
      mainList.append([line]);
      if (line.matched) focusList.append([line]);
    });
    const unlisten_serial_datas = listen<SerialMessage[]>('serial-datas', (e) => mainList.replace(e.payload));
    const unlisten_serial_datas_focus = listen<SerialMessage[]>('serial-datas-focus', (e) => focusList.replace(e.payload));
    const unlisten_serial_datas_append = listen<SerialMessage[]>('serial-datas-append', (e) => {
      const arrivedAt = Date.now();
      mainList.append(e.payload.map(line => ({ ...line, arrivedAt })));
    });
    const unlisten_serial_datas_focus_append = listen<SerialMessage[]>('serial-datas-focus-append', (e) => {
      const arrivedAt = Date.now();
      focusList.append(e.payload.map(line => ({ ...line, arrivedAt })));
    });
    // Emitted when an MCP client calls clear_logs, so the window stays in sync
    // with what the agent just did to the shared buffer.
    const unlisten_logs_cleared = listen('logs-cleared', () => {
      mainList.replace([]);
      focusList.replace([]);
    });
    const unlisten_serial_connection = listen<boolean>('serial-connection', (e) => setIsSerialConnected(e.payload));

    return () => {
      unlisten_serial_data.then(f => f());
      unlisten_serial_datas.then(f => f());
      unlisten_serial_datas_focus.then(f => f());
      unlisten_serial_datas_append.then(f => f());
      unlisten_serial_datas_focus_append.then(f => f());
      unlisten_logs_cleared.then(f => f());
      unlisten_serial_connection.then(f => f());
    };
  }, [mainList, focusList]);

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

  // Distance between the buttons over the main terminal and its right edge, so they stay clear of
  // the scrollbar and the minimap
  const mainOverlayRight = 28 + (config.showMinimap ? MINIMAP_WIDTH : 0);

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
                <Box sx={{ height: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 10,
                      right: mainOverlayRight,
                      zIndex: 2,
                      display: 'flex',
                      gap: 1,
                    }}
                  >
                    <ToolbarButton title="Search (Ctrl+F)" label="search" active={search.isOpen} onClick={search.isOpen ? search.close : search.open}>
                      <SearchIcon fontSize="medium" />
                    </ToolbarButton>
                    <ToolbarButton title="Auto-scroll" label="toggle auto-scroll" active={isMainAutoScrollEnabled} onClick={onToggleAutoScrollFromLogs}>
                      <KeyboardArrowDownIcon fontSize="medium" />
                    </ToolbarButton>
                    <ToolbarButton title="Apply current highlight rules to all logs (Usefull when rules have changed)" label="refresh logs" onClick={onClickRefreshAll}>
                      <RefreshIcon fontSize="medium" />
                    </ToolbarButton>
                    <ToolbarButton title="Insert a marker (Ctrl+M)" label="insert marker" onClick={addMarker}>
                      <BookmarkAddOutlinedIcon fontSize="medium" />
                    </ToolbarButton>
                    <ToolbarButton title="Save logs to file" label="save logs to file" onClick={() => saveLines(logs)}>
                      <SaveIcon fontSize="medium" />
                    </ToolbarButton>
                    <ToolbarButton title="Clear logs (Ctrl+Shift+R)" label="clear logs" onClick={onClearLogs}>
                      <DeleteOutlineIcon fontSize="medium" />
                    </ToolbarButton>
                    <ToolbarButton title="More options" label="more options" onClick={(e) => setMainMenuAnchor(e.currentTarget)}>
                      <MoreVertIcon fontSize="medium" />
                    </ToolbarButton>
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
                    <Box sx={{ position: 'absolute', top: 54, right: mainOverlayRight, zIndex: 2 }}>
                      <SearchBar search={search} inputRef={searchInputRef} />
                    </Box>
                  )}
                  <Box sx={{ flex: 1, minHeight: 0 }}>
                    <SerialTerminal
                      rows={mainRows}
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
                      minimap={config.showMinimap}
                    />
                  </Box>
                  <SendBar
                    connected={isSerialConnected}
                    lineEnding={config.sendLineEnding}
                    onLineEndingChange={(sendLineEnding) => updateConfig({ sendLineEnding })}
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
                  <ToolbarButton title="Auto-scroll" label="toggle focus auto-scroll" active={isFocusAutoScrollEnabled} onClick={onToggleAutoScrollFromFocus}>
                    <KeyboardArrowDownIcon fontSize="medium" />
                  </ToolbarButton>
                  <ToolbarButton title="Save focus logs to file" label="save focus logs to file" onClick={() => saveLines(focusLogs)}>
                    <SaveIcon fontSize="medium" />
                  </ToolbarButton>
                  <ToolbarButton title="Clear focus logs (Ctrl+Shift+R)" label="clear focus logs" onClick={clearFocusLogs}>
                    <DeleteOutlineIcon fontSize="medium" />
                  </ToolbarButton>
                </Box>
                <SerialTerminal
                  rows={focusRows}
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
