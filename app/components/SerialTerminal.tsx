'use client';

import React, { useState, type Ref,  type UIEventHandler } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import Box from '@mui/material/Box';
import RowComponent from './SerialTerminalLine';
import { SerialMessage } from '../types/SerialMessage';

interface SerialTerminalProps {
  serial_messages: SerialMessage[];
  height?: number | string;
  width?: number | string;
  listRef?: Ref<ListImperativeAPI>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onClickRow?: (message_id: number) => void;
  selectedLineId?: number | null;
}

const SerialTerminal: React.FC<SerialTerminalProps> = ({
  serial_messages,
  height = '100%',
  width = '100%',
  listRef,
  onScroll,
  onClickRow,
  selectedLineId: externalSelectedLineId,
}) => {
  const [internalSelectedLineId, setInternalSelectedLineId] = useState<number | null>(null);

  const selectedLineId = externalSelectedLineId !== undefined ? externalSelectedLineId : internalSelectedLineId;

  const handleClickRow = (message_id: number) => {
    if (externalSelectedLineId === undefined) {
      setInternalSelectedLineId(prev => prev === message_id ? null : message_id);
    }
    onClickRow?.(message_id);
  };

  return (
    <Box
      sx={{
        height: height,
        width: width,
        bgcolor: '#1e1e1e',
        color: '#d4d4d4',
        p: 1,
        borderRadius: 1,
        overflow: 'hidden',
        border: '1px solid #333',
      }}
    >
        <List
          id='SerialLinesList'
          style={{ height, width, paddingBottom:'20px'}}
          rowCount={serial_messages.length}
          rowHeight={(index) => {
            const line = serial_messages[index];
            return line?.removed_line ? 0 : 20;
          }}
          rowComponent={RowComponent}
          rowProps={{ serialMessages: serial_messages, onClickRow: handleClickRow, selectedLineId }}
          overscanCount={10}
          listRef={listRef}
          onScroll={onScroll}
        />

    </Box>
  );
};

export default SerialTerminal;
