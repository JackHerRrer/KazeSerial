'use client';

import React, { useState, useRef, useEffect, type SyntheticEvent} from 'react';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import { Resizable } from 're-resizable';
import type { ListImperativeAPI } from 'react-window';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { listen } from '@tauri-apps/api/event';
import { invoke } from "@tauri-apps/api/core";
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import LastPageIcon from '@mui/icons-material/LastPage';
import FirstPageIcon from '@mui/icons-material/FirstPage';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import { save, open as openDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import ControlPanel from './components/ControlPanel';
import SerialTerminal from './components/SerialTerminal';
import { SerialMessage } from './types/SerialMessage';
let currentTime = 0;

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
  },
  typography: {
    button: {
      textTransform: 'none'
    }
  }
});

// Generate fake UART logs
const generateLogs = (count: number) =>  {
  const logs = [];

  for (let i = 0; i < count; i++) {
    currentTime += Math.random() * 0.1;
    const timestamp = `[${currentTime.toFixed(6)}]`;
    let message = '';
    
    const type = Math.random();
    if (type < 0.1) {
      message = `ERROR: Connection timeout at address 0x${Math.floor(Math.random() * 0xffff).toString(16)}                                                                                                        00000000`;
    } else if (type < 0.3) {
      message = `WARN: Retrying packet ${i}...                                                                                                          00000000`;
    } else if (type < 0.6) {
      message = `INFO: Received packet len=${Math.floor(Math.random() * 100)} flags=0x${Math.floor(Math.random() * 0xff).toString(16)}                                                                                                          00000000`;
    } else {
      message = `DEBUG: Processing data chunk ${i} state=${Math.floor(Math.random() * 5)}`;
    }
    logs.push(`${timestamp} ${message}`);
  }
  return logs;

};

const serialUart = ['UART0', 'UART1', 'UART2', 'UART3'];
const initialLogs: SerialMessage[] = [];


export default function Home() {
  const listRefMain = useRef<ListImperativeAPI>(null!);
  const listRefFocus = useRef<ListImperativeAPI>(null!);
  const ignoreMainScrollUntilRef = useRef(0);
  const ignoreFocusScrollUntilRef = useRef(0);
  
  const [logs, setLogs] = useState<SerialMessage[]>(initialLogs);
  const [focusLogs, setFocusLogs] = useState<SerialMessage[]>(initialLogs);
  const [selectedMainLineId, setSelectedMainLineId] = useState<number | null>(null);
  const [isMainAutoScrollEnabled, setIsMainAutoScrollEnabled] = useState(true);
  const [isFocusAutoScrollEnabled, setIsFocusAutoScrollEnabled] = useState(true);


  const [isSettingsPanelOpen, setIsSettingsPanelOpen] = useState(true);
  const [isFocusPanelOpen, setIsFocusPanelOpen] = useState(true);
  const [mainMenuAnchor, setMainMenuAnchor] = useState<null | HTMLElement>(null);

  const appendLogs = (count: number) => {
    let newLogs: String[] = generateLogs(count);
    invoke<void>("append_logs_line", { lines: newLogs })
    .then(() => {
    }).catch((err: unknown) => {
        console.error(err);
    });
  };

  const addSingleLog = (log: SerialMessage) => {
    let insertedIndex: number = logs.length;
    setLogs(prevLogs => {
      return [...prevLogs, log];
    });
    return insertedIndex; // Retourne l'index de la ligne insérée
  };

  const addSingleFocusLog = (log: SerialMessage) => {
    let tmpArr = [log];
    setFocusLogs(prevLogs => [...prevLogs, ...tmpArr]);
  };
  const regenerateLogs = () => {
    currentTime = 0; // Reset time for new logs
    let logs :String[] = generateLogs(10);
    invoke<string[]>("add_logs_line", { lines: logs })
    .then((s) => {
        //console.log("port opened:", s);
    }).catch((err: unknown) => {
        console.error(err);
    });
  };
  const clearLogs = () => {
    let tmpArr: SerialMessage[] = [];
    setLogs(tmpArr);
  };
  const clearFocusLogs = () => {
    let tmpArr: SerialMessage[] = [];
    setFocusLogs(tmpArr);
  };
  const onClickFocusLogs = (id:number) => {
    const list = listRefMain.current;
    // Trouver l'index du message dans logs en utilisant son id
    const index = logs.findIndex(log => log.id === id);
    
    if (index !== -1) {
      const list = listRefMain.current;
      list?.scrollToRow({
        align: "center", // Centre l'élément dans la vue
        behavior: "smooth", // Animation fluide
        index: index
      });
      setSelectedMainLineId(prev => prev === id ? null : id);
    }
  };
  const onClickRefreshAll = () => {
    let currentLogs = logs;
    clearFocusLogs();
    clearLogs();
    let logs_string:String[] = [];
    for (let log of currentLogs) {
      logs_string.push(log.rawline ?? log.message);
    }
    invoke<string[]>("add_logs_line", { lines: logs_string })
      .then((s) => {
      }).catch((err: unknown) => {
        console.error(err);
      });
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
      //listen to a event
      const unlisten_serial_data = listen<SerialMessage>("serial-data", (e) => {
        //console.log(e);
        //console.log("receive " + e.payload.message.length + " is matched" + e.payload.matched);
        let serialMessage: SerialMessage = e.payload;
        addSingleLog(serialMessage);
        if(e.payload.matched)
        {
          addSingleFocusLog(serialMessage);
        }
      });
      //listen to a event
      const unlisten_serial_datas = listen<SerialMessage[]>("serial-datas", (e) => {
        //console.log(e);
        //console.log("receive " + e.payload.message.length + " is matched" + e.payload.matched);
        let serialMessages: SerialMessage[] = e.payload;
        setLogs(serialMessages)
      });
      const unlisten_serial_datas_append = listen<SerialMessage[]>("serial-datas-append", (e) => {
        setLogs(prevLogs => [...prevLogs, ...e.payload]);
      });
      const unlisten_serial_datas_focus_append = listen<SerialMessage[]>("serial-datas-focus-append", (e) => {
        setFocusLogs(prevLogs => [...prevLogs, ...e.payload]);
      });
      const unlisten_serial_datas_focus = listen<SerialMessage[]>("serial-datas-focus", (e) => {
        //console.log(e);
        //console.log("receive " + e.payload.message.length + " is matched" + e.payload.matched);
        let serialMessages: SerialMessage[] = e.payload;
        setFocusLogs(serialMessages)
      });

      return () => {
        unlisten_serial_data.then(f => f());
        unlisten_serial_datas.then(f => f());
        unlisten_serial_datas_focus.then(f => f());
        unlisten_serial_datas_append.then(f => f());
        unlisten_serial_datas_focus_append.then(f => f());
      }
    }, [] );


  const scrollToRow = (listRef: React.RefObject<ListImperativeAPI>, rowIndex: number, behavior: 'auto' | 'smooth' = 'smooth') => {
    listRef.current?.scrollToRow({
      align: "end",
      behavior: behavior,
      index: rowIndex,
    });
  };

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
    isAutoScrollEnabled: boolean,
    setIsAutoScrollEnabled: React.Dispatch<React.SetStateAction<boolean>>,
    ignoreScrollUntilRef: React.MutableRefObject<number>
  ) => (event: SyntheticEvent<HTMLDivElement>) => {
    if (Date.now() < ignoreScrollUntilRef.current) {
      return;
    }

    if (event.nativeEvent == null) {
      return;
    }
    const myTarget: HTMLDivElement = event.nativeEvent.target as HTMLDivElement;
    const diff = myTarget.scrollHeight - myTarget.clientHeight - myTarget.scrollTop;

    if (diff == 0) {
      if (!isAutoScrollEnabled) {
        setIsAutoScrollEnabled(true);
      }
    } else if (diff > 30) {
      if (isAutoScrollEnabled) {
        setIsAutoScrollEnabled(false);
      }
    }
  };
  console.log("render page");

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
                    <Tooltip title="Load log file" placement="top" arrow>
                    <IconButton
                      aria-label="load log file"
                      size="medium"
                      color="inherit"
                      onClick={async () => {
                        const selected = await openDialog({ directory: false, multiple: false }).catch(() => undefined);
                        if (selected) {
                          const contents = await readTextFile(selected);
                          const lines = contents.split('\n').filter(l => l.length > 0);
                          invoke<void>('add_logs_line', { lines }).catch((err: unknown) => console.error(err));
                        }
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
                      <FolderOpenIcon fontSize="medium" />
                    </IconButton>
                    </Tooltip>
                    <Tooltip title="Save logs to file" placement="top" arrow>
                    <IconButton
                      aria-label="save logs to file"
                      size="medium"
                      color="inherit"
                      onClick={async () => {
                        let buf = '';
                        for (const msg of logs) {
                          buf += (msg.rawline ?? msg.message) + '\n';
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
                  <Tooltip title="Clear logs" placement="top" arrow>
                  <IconButton
                    aria-label="clear logs"
                    size="medium"
                    color="inherit"
                    onClick={clearLogs}
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
                      <MenuItem onClick={() => { regenerateLogs(); setMainMenuAnchor(null); }}>Demo - Append 10 logs</MenuItem>
                    </Menu>
                  </Box>
                  <SerialTerminal
                    serial_messages={logs}
                    listRef={listRefMain}
                    onScroll={handleScroll(isMainAutoScrollEnabled, setIsMainAutoScrollEnabled, ignoreMainScrollUntilRef)}
                    selectedLineId={selectedMainLineId}
                    onClickRow={(id) => setSelectedMainLineId(prev => prev === id ? null : id)}
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
                      for (const msg of focusLogs) {
                        buf += (msg.rawline ?? msg.message) + '\n';
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
                  <Tooltip title="Clear focus logs" placement="top" arrow>
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
                  onScroll={handleScroll(isFocusAutoScrollEnabled, setIsFocusAutoScrollEnabled, ignoreFocusScrollUntilRef)}
                  onClickRow={onClickFocusLogs}
                />
              </Box>
              )}
            </Container>
            </Box>
          </Box>

          {/* Settings panel — resizable when open, thin strip when closed */}
          {isSettingsPanelOpen ? (
            <Resizable
              enable={{ left: true, top: false, right: false, bottom: false, topLeft: false, topRight: false, bottomLeft: false, bottomRight: false }}
              minWidth={220}
              maxWidth='70%'
              defaultSize={{ width: '30%', height: '100%' }}
              style={{ height: '100%', borderLeft: '1px solid #333', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            >
              <Box sx={{ flex: 1, overflow: 'hidden' }}>
                <ControlPanel
                  onAppendLogs={() => appendLogs(10000)}
                  onRegenerateLogs={regenerateLogs}
                />
              </Box>
            </Resizable>
          ) : (
            <Box
              sx={{
                height: '100%',
                flexShrink: 0,
                borderLeft: '1px solid #333',
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
        </Container>
    </ThemeProvider>
  );
}
