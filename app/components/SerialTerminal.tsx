'use client';

import React, { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref,  type UIEventHandler } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import BookmarkAddOutlinedIcon from '@mui/icons-material/BookmarkAddOutlined';
import RowComponent, { MARKER_COLOR } from './SerialTerminalLine';
import LogMinimap, { MINIMAP_WIDTH, scrollByWheel, type LogMinimapHandle } from './LogMinimap';
import { SerialMessage } from '../types/SerialMessage';
import { type SearchMatch } from '../utils/search';
import { NO_ROWS, rowCount, rowOf, terminalRows } from '../utils/terminalRows';

// Padding of the terminal box, in px
const TERMINAL_PADDING = 8;
// Height of a row, in px
const ROW_HEIGHT = 20;
// Distance between the insert marker button and the right edge of the list, in px, so the
// button stays clear of the vertical scrollbar
const INSERT_MARKER_RIGHT_GAP = 20;

/** Line number gutter: number shown for each line index, and digit count of the widest number */
export type LineNumbers = {
  numberOf: (index: number) => number | undefined;
  digits: number;
};

/** Search matches to highlight: every match of `regex`, `current` more visibly */
export type RowSearch = {
  regex: RegExp;
  current?: SearchMatch;
};

/** New line highlight: lines appended to the view fade from `color` over `durationMs` */
export type Arrival = {
  durationMs: number;
  color: string;
};

/**
 * Timestamp column; `inText` makes it selectable and part of the copied text, `inactivityMs`
 * only shows it on lines arriving after that long without any line. `width` is the width of a
 * timestamp formatted with `format`, in characters.
 */
export type Timestamps = {
  inText: boolean;
  inactivityMs?: number;
  format: string;
  width: number;
};

interface SerialTerminalProps {
  serial_messages: SerialMessage[];
  listRef?: Ref<ListImperativeAPI>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onClickRow?: (message_id: number) => void;
  onInsertMarker?: (message_id: number) => void;
  selectedLineId?: number | null;
  lineNumbers?: LineNumbers;
  timestamps?: Timestamps;
  arrival?: Arrival;
  search?: RowSearch;
  minimap?: boolean;
}

const SerialTerminal: React.FC<SerialTerminalProps> = ({
  serial_messages,
  listRef,
  onScroll,
  onClickRow,
  onInsertMarker,
  selectedLineId: externalSelectedLineId,
  lineNumbers,
  timestamps,
  arrival,
  search,
  minimap = false,
}) => {
  const [internalSelectedLineId, setInternalSelectedLineId] = useState<number | null>(null);

  // Row under the pointer, highlighted. The insert marker button is a single button over the list,
  // at a fixed distance from its right edge so horizontal scrolling does not move it, at the
  // height of that row.
  const boxRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const [hoveredRow, setHoveredRow] = useState<{ id: number; top: number } | null>(null);

  // Lines hidden by a remove rule get no row, so every row has the same height: the list then
  // finds the rows in view without measuring the rows above them. The rows of the previous lines
  // are kept, so a new line only scans itself
  const [previousRows, setPreviousRows] = useState(NO_ROWS);
  const rows = terminalRows(serial_messages, previousRows);
  if (rows !== previousRows) setPreviousRows(rows);

  // The list is also scrolled by the minimap, so its API is kept here and forwarded to `listRef`,
  // which scrolls to line indices
  const listApiRef = useRef<ListImperativeAPI | null>(null);
  const minimapRef = useRef<LogMinimapHandle>(null);
  useImperativeHandle(listRef, () => ({
    get element() {
      return listApiRef.current?.element ?? null;
    },
    scrollToRow: (params) => {
      if (rowCount(rows) > 0) listApiRef.current?.scrollToRow({ ...params, index: rowOf(rows, params.index) });
    },
  }), [rows]);

  // Finds the row at the pointer height and its top relative to the box. Only the height counts:
  // scrolled horizontally, short rows no longer reach the pointer. Called when the pointer moves,
  // and when rows move under it.
  const updateHoveredRow = () => {
    const box = boxRef.current;
    const pointer = pointerRef.current;
    // Measured only while the pointer is over the terminal: it forces the browser to compute the layout
    const listRect = pointer ? listApiRef.current?.element?.getBoundingClientRect() : undefined;
    let next: { id: number; top: number } | null = null;
    // Not over the minimap, on the right of the list
    if (box && pointer && (!listRect || pointer.x < listRect.right)) {
      // Only the rendered rows, so a few dozen
      const row = Array.from(box.querySelectorAll<HTMLElement>('.serial-terminal-row')).find(element => {
        const rect = element.getBoundingClientRect();
        return rect.top <= pointer.y && pointer.y < rect.bottom;
      });
      if (row) {
        const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientTop;
        next = { id: Number(row.dataset.lineId), top };
      }
    }
    setHoveredRow(prev => prev?.id === next?.id && prev?.top === next?.top ? prev : next);
  };

  // After each render: replaced or added lines may change the row under the pointer without any
  // scroll. The state only changes when the row does, so this does not render again otherwise.
  useLayoutEffect(updateHoveredRow);

  const selectedLineId = externalSelectedLineId !== undefined ? externalSelectedLineId : internalSelectedLineId;

  const handleClickRow = (message_id: number) => {
    if (externalSelectedLineId === undefined) {
      setInternalSelectedLineId(prev => prev === message_id ? null : message_id);
    }
    onClickRow?.(message_id);
  };

  const handleCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.serial-terminal-row'));
    const lines: string[] = [];
    for (const row of rows) {
      if (!range.intersectsNode(row)) continue;
      const rowRange = document.createRange();
      rowRange.selectNodeContents(row);
      const intersect = range.cloneRange();
      if (intersect.compareBoundaryPoints(Range.START_TO_START, rowRange) < 0) {
        intersect.setStart(rowRange.startContainer, rowRange.startOffset);
      }
      if (intersect.compareBoundaryPoints(Range.END_TO_END, rowRange) > 0) {
        intersect.setEnd(rowRange.endContainer, rowRange.endOffset);
      }
      lines.push(intersect.toString());
    }
    if (lines.length > 1) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', lines.join('\n'));
    }
  };

  return (
    <Box
      ref={boxRef}
      onCopy={handleCopy}
      onMouseMove={(e) => {
        pointerRef.current = { x: e.clientX, y: e.clientY };
        updateHoveredRow();
      }}
      onMouseLeave={() => {
        pointerRef.current = null;
        setHoveredRow(null);
      }}
      sx={{
        position: 'relative',
        height: '100%',
        width: '100%',
        bgcolor: '#1e1e1e',
        color: '#d4d4d4',
        p: `${TERMINAL_PADDING}px`,
        borderRadius: 1,
        overflow: 'hidden',
        border: '1px solid #333',
        display: 'flex',
      }}
    >
        <List
          id='SerialLinesList'
          // The minimap shows the scroll position, so the list has no vertical scrollbar then: it
          // does not scroll vertically by itself, and the wheel scrolls it. CSS cannot hide only the
          // vertical scrollbar in every webview: `scrollbar-width: none` also hides the horizontal
          // one, `::-webkit-scrollbar` is ignored by WebView2 since `scrollbar-width` is set, and
          // overlay scrollbars (WebKitGTK) take no width to clip.
          style={{ height: '100%', flex: 1, minWidth: 0, paddingBottom:'20px', overflowY: minimap ? 'hidden' : 'auto', overflowX: 'auto' }}
          rowCount={rowCount(rows)}
          rowHeight={ROW_HEIGHT}
          rowComponent={RowComponent}
          rowProps={{ rows, onClickRow: handleClickRow, selectedLineId, hoveredLineId: hoveredRow?.id, lineNumbers, timestamps, arrival, search }}
          overscanCount={10}
          listRef={listApiRef}
          onScroll={(event) => {
            onScroll(event);
            updateHoveredRow();
            minimapRef.current?.redraw();
          }}
          onWheel={minimap ? (event) => scrollByWheel(event.currentTarget, event, ROW_HEIGHT) : undefined}
        />
        {minimap && (
          <LogMinimap
            ref={minimapRef}
            rows={rows}
            listApiRef={listApiRef}
            rowHeight={ROW_HEIGHT}
            selectedLineId={selectedLineId}
            search={search}
          />
        )}
        {onInsertMarker && hoveredRow && (
          <Tooltip title="Insert a marker above" placement="left" arrow>
            <IconButton
              aria-label="insert a marker above"
              size="small"
              onClick={() => onInsertMarker(hoveredRow.id)}
              sx={{
                position: 'absolute',
                top: hoveredRow.top,
                right: TERMINAL_PADDING + INSERT_MARKER_RIGHT_GAP + (minimap ? MINIMAP_WIDTH : 0),
                zIndex: 1,
                width: 20,
                height: 20,
                p: 0,
                borderRadius: 1,
                color: MARKER_COLOR,
                bgcolor: '#1e1e1e',
                '&:hover': { bgcolor: '#333' },
              }}
            >
              <BookmarkAddOutlinedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}

    </Box>
  );
};

export default SerialTerminal;
