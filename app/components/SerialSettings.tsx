'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select, { SelectChangeEvent } from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import { invoke } from "@tauri-apps/api/core";
import RefreshIcon from '@mui/icons-material/Refresh';

type SerialPortEntry = {
  portName: string;
  deviceLabel: string;
};

const SerialSettings: React.FC = () => {
  const isCancelled = React.useRef(false);
  const [port, setPort] = useState('');
  const [baudRate, setBaudRate] = useState(115200);
  const [ports, setPorts] = useState<SerialPortEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  React.useEffect(() => {
    if(port.length == 0 && ports[0] == undefined)
    {
        listUart();
    }
    return () => {
      isCancelled.current = true;
    };
  }, []);

  const handlePortChange = (event: SelectChangeEvent) => {
    setPort(event.target.value as string);
  };

  const handleBaudRateChange = (event: SelectChangeEvent<number>) => {
    setBaudRate(event.target.value as number);
  };
  const handleConnect = () => {
    //console.log("connect to", port, "at", baudRate);
    if(isConnected == false)
    {
        invoke<string[]>("open_port", { portName: port, baudRate: baudRate })
            .then((s) => {
                console.log("port opened:", s);
            }).catch((err: unknown) => {
                console.error(err);
            });
    }else{
        invoke<void>("close_port")
            .then(() => {
                console.log("port closed");
            }).catch((err: unknown) => {
                console.error(err);
            });
    }

    isConnected ? setIsConnected(false) : setIsConnected(true);

  };
  const listUart = () => {
    invoke<SerialPortEntry[]>("list_ports")
      .then((s) => {
        if (!isCancelled.current) {
            setPorts(s);
        }

        if(port.length == 0 && s[0] != undefined && s[0].portName.length > 0)
        {
            setPort(s[0].portName);
        }
      })
      .catch((err: unknown) => {
        console.error(err);
      });
  };

  const renderPortLabel = (portEntry: SerialPortEntry) => (
    <Box
      component="span"
      sx={{
        display: 'block',
        width: '100%',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {portEntry.portName} - {portEntry.deviceLabel}
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, width: '100%' }}>
        <IconButton
          aria-label="detect serial"
          size="small"
          color="primary"
          onClick={listUart}
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            width: 40,
            height: 40,
          }}
        >
          <RefreshIcon fontSize="small" />
        </IconButton>
        <FormControl size="small" sx={{ flex: 1, minWidth: 0, width: 0 }}>

          <InputLabel id="serial-port-select-label">Port</InputLabel>
          <Select
            labelId="serial-port-select-label"
            id="serial-port-select"
            value={port}
            label="Port"
            onChange={handlePortChange}
            renderValue={(selected) => {
              const selectedPort = ports.find((p) => p.portName === (selected as string));
              if (!selectedPort) {
                return selected as string;
              }
              return renderPortLabel(selectedPort);
            }}
            MenuProps={{
              PaperProps: {
                sx: {
                  maxWidth: 'min(90vw, 560px)',
                },
              },
            }}
            sx={{
              width: '100%',
              minWidth: 0,
              '& .MuiSelect-select': {
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }}
          >

            {ports.map((p) => (
              <MenuItem key={p.portName} value={p.portName} sx={{ minWidth: 0, maxWidth: '100%' }}>
                {renderPortLabel(p)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>
      <FormControl fullWidth size="small">
        <InputLabel id="baud-rate-select-label">Baud Rate</InputLabel>
        <Select
          labelId="baud-rate-select-label"
          id="baud-rate-select"
          value={baudRate}
          label="Baud Rate"
          onChange={handleBaudRateChange}
        >
          <MenuItem value={9600}>9600</MenuItem>
          <MenuItem value={19200}>19200</MenuItem>
          <MenuItem value={38400}>38400</MenuItem>
          <MenuItem value={57600}>57600</MenuItem>
          <MenuItem value={115200}>115200</MenuItem>
          <MenuItem value={230400}>230400</MenuItem>
          <MenuItem value={460800}>460800</MenuItem>
          <MenuItem value={921600}>921600</MenuItem>
        </Select>
      </FormControl>
      <Button variant="outlined" size="small" color="primary" onClick={handleConnect}>
        {isConnected ? 'Disconnect' : 'Connect'}
      </Button>
    </Box>
  );
};

export default SerialSettings;
