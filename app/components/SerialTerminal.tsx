'use client';

import React, { type Ref,  type UIEventHandler } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import Box from '@mui/material/Box';
import RowComponent from './SerialTerminalLine';

interface SerialTerminalProps {
  lines: string[];
  height?: number | string;
  width?: number | string;
  listRef?: Ref<ListImperativeAPI>;
  onScroll: UIEventHandler<HTMLDivElement>;
}

const SerialTerminal: React.FC<SerialTerminalProps> = ({
  lines,
  height = '100%',
  width = '100%',
  listRef,
  onScroll,
}) => {

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
          rowCount={lines.length}
          rowHeight={20}
          rowComponent={RowComponent}
          rowProps={{ names: lines }} // Pass lines via rowProps
          overscanCount={10}
          listRef={listRef}
          onScroll={onScroll}
        />

    </Box>
  );
};

export default SerialTerminal;
