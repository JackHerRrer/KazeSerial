'use client';

import React, { useState, useRef, useEffect, type SyntheticEvent} from 'react';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import SerialTerminal from './components/SerialTerminal';
import { Resizable } from 're-resizable';
import type { ListImperativeAPI } from 'react-window';
import ControlPanel from './components/ControlPanel';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { listen } from '@tauri-apps/api/event';
import { invoke } from "@tauri-apps/api/core";
import Typography from '@mui/material/Typography';
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
const generateLogs = (count: number) => {
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

    invoke<string[]>("add_logs_line", { line: `${timestamp} ${message}` })
        .then((s) => {
            //console.log("port opened:", s);
        }).catch((err: unknown) => {
            console.error(err);
        });
  }
};

const serialUart = ['UART0', 'UART1', 'UART2', 'UART3'];
const initialLogs: SerialMessage[] = [];


export default function Home() {
  const listRefMain = useRef<ListImperativeAPI>(null!);
  const listRefFocus = useRef<ListImperativeAPI>(null!);
  
  const [logs, setLogs] = useState<SerialMessage[]>(initialLogs);
  const [focusLogs, setFocusLogs] = useState<SerialMessage[]>(initialLogs);
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);


  const appendLogs = (count: number) => {
    generateLogs(count);
  };

  const addSingleLog = (log: SerialMessage) => {
    let tmpArr = [log];
    setLogs(prevLogs => [...prevLogs, ...tmpArr]);
  };

  const addSingleFocusLog = (log: SerialMessage) => {
    let tmpArr = [log];
    setFocusLogs(prevLogs => [...prevLogs, ...tmpArr]);
  };
  const regenerateLogs = () => {
    currentTime = 0; // Reset time for new logs
    generateLogs(10);
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
    console.log('click log id:', id);
  };
  useEffect(() => {
    if (isAutoScrollEnabled) {
      if (listRefMain.current) {
        if(logs.length > 0)
          scrollToRow(listRefMain, logs.length - 1, 'auto');
      }
      if (listRefFocus.current) {
        if(focusLogs.length > 0)
          scrollToRow(listRefFocus, focusLogs.length - 1, 'auto');
      }
    }
  }, [logs, focusLogs]);

  useEffect(() => {
      //listen to a event
      const unlisten = listen<SerialMessage>("serial-data", (e) => {
        //console.log(e);
        //console.log("receive " + e.payload.message.length + " is matched" + e.payload.matched);
        let serialMessage: SerialMessage = e.payload;
        addSingleLog(serialMessage);
        if(e.payload.matched)
        {
          addSingleFocusLog(serialMessage);
        }
      });

      return () => {
        unlisten.then(f => f());
      }
    }, [] );


  const scrollToRow = (listRef: React.RefObject<ListImperativeAPI>, rowIndex: number, behavior: 'auto' | 'smooth' = 'smooth') => {
    listRef.current?.scrollToRow({
      align: "end",
      behavior: behavior,
      index: rowIndex,
    });
  };

  const handleScroll = (listRef: React.RefObject<ListImperativeAPI>) => (event:SyntheticEvent<HTMLDivElement>) => {
    if(event.nativeEvent == null) {
      return;
    }
    const myTarget :HTMLDivElement = event.nativeEvent.target as HTMLDivElement;
    let diff = myTarget.scrollHeight - myTarget.clientHeight - myTarget.scrollTop;
    if(diff == 0) {
      if (!isAutoScrollEnabled) {
        setIsAutoScrollEnabled(true);
      }
    } else if((diff > 30)) {
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
        <Container disableGutters maxWidth={false} sx={{ py: 0, height: '100vh', width:'100%', display:'flex', flexDirection: 'row' ,pl:0, pr:0}}>
          {/* Horizontal resizable Container */}
          <Resizable minHeight='100%' maxWidth='90%' maxHeight='100%' defaultSize={{ width: '70%',height: '100%',}}>
            {/* Serial vertical Container */}
            <Container disableGutters maxWidth={false} sx={{ py: 1, height: '100vh', width:'100%', display:'flex', flexDirection: 'column' ,pl:0, pr:0}}>
              {/* Main Serial Terminal */}
              <Resizable
                minWidth='100%'
                maxWidth='100%'
                maxHeight='90%'
                defaultSize={{
                  width: '100%',
                  height: '70%',
                }}
                >
                  <SerialTerminal
                    serial_messages={logs}
                    listRef={listRefMain}
                    onScroll={handleScroll(listRefMain)}
                  />
              </Resizable>
              {/* Focus Serial Terminal */}
              <Typography
              component="span"
              sx={{
                fontFamily: 'monospace',
                fontSize: '0.875rem',
                color: '#d4d4d4',
                lineHeight: 1.2,
              }}
            >
              {"focus"}
            </Typography>
              <Box sx={{ flexGrow: 1,  minHeight: '10%' }}>
                <SerialTerminal
                  serial_messages={focusLogs}
                  listRef={listRefFocus}
                  onScroll={handleScroll(listRefFocus)}
                  onClickRow={onClickFocusLogs}
                />
              </Box>
            </Container>
          </Resizable>

          <Container disableGutters sx={{ height: '100vh' }}>
            {/* Control Panel */}
            <ControlPanel 
              onAppendLogs={() => appendLogs(10)}
              onRegenerateLogs={regenerateLogs}
              isAutoScrollEnabled={isAutoScrollEnabled}
              onToggleAutoScroll={() => setIsAutoScrollEnabled(prev => !prev)}
              onClickClearLog={clearLogs}
              onClickClearFocusLog={clearFocusLogs}
              logs={logs}
              focusLogs={focusLogs}
            />
          </Container>
        </Container>
    </ThemeProvider>
  );
}
