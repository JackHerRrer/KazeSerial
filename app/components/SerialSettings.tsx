'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select, { SelectChangeEvent } from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import { useEffect } from 'react'
import { invoke } from "@tauri-apps/api/core";

const SerialSettings: React.FC = () => {
  const isCancelled = React.useRef(false);
  const [port, setPort] = useState('');
  const [baudRate, setBaudRate] = useState(115200);
  const [ports, setPorts] = useState<string[]>([]);
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
    invoke<string[]>("list_ports")
      .then((s) => {
        if (!isCancelled.current) {
            setPorts(s);
        }

        if(port.length == 0 && s[0] != undefined && s[0].length>0)
        {
            setPort(s[0]);
        }
      })
      .catch((err: unknown) => {
        console.error(err);
      });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Button variant="outlined" size="small" color="primary" onClick={listUart}>
        Detect serial
      </Button>
      <FormControl fullWidth size="small">

        <InputLabel id="serial-port-select-label">Port</InputLabel>
        <Select
          labelId="serial-port-select-label"
          id="serial-port-select"
          value={port}
          label="Port"
          onChange={handlePortChange}
        >

          {ports.map((p) => (
            <MenuItem key={p} value={p}>
              {p}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
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
