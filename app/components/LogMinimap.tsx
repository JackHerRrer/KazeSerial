'use client';

import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type Ref, type RefObject } from 'react';
import type { ListImperativeAPI } from 'react-window';
import Box from '@mui/material/Box';
import { MARKER_COLOR } from './SerialTerminalLine';
import { type RowSearch } from './SerialTerminal';
import { SerialMessage } from '../types/SerialMessage';
import { lineRanges, unescapeHtml } from '../utils/search';

// Width of the minimap, in px
export const MINIMAP_WIDTH = 80;
// Height of a line and width of a character in the minimap, in px
const MINIMAP_ROW_HEIGHT = 2;
const MINIMAP_CHAR_WIDTH = 1;
// Space between the left edge of the minimap and the start of the lines, in px
const MINIMAP_LEFT_PADDING = 4;

const MINIMAP_BACKGROUND = '#1e1e1e';
// Text without highlight color, drawn dimmed like the colored text
const TEXT_COLOR = '#d4d4d4';
const TEXT_ALPHA = 0.6;
const SELECTED_ROW_COLOR = 'rgba(255, 255, 255, 0.25)';
// Search matches: a tint over the whole line so short matches stay visible, and the match itself,
// the current match more visible, as in the terminal
const SEARCH_ROW_COLOR = 'rgba(230, 190, 60, 0.25)';
const SEARCH_MATCH_COLOR = 'rgba(230, 190, 60, 0.9)';
const SEARCH_CURRENT_COLOR = 'rgba(255, 140, 0, 1)';
// Slider showing the part of the log visible in the terminal
const SLIDER_COLOR = 'rgba(121, 121, 121, 0.2)';
const SLIDER_HOVER_COLOR = 'rgba(121, 121, 121, 0.35)';
const SLIDER_DRAG_COLOR = 'rgba(191, 191, 191, 0.4)';

/** Scrolls `list` vertically by the wheel delta of `event`, for a list that does not scroll by itself */
export const scrollByWheel = (list: HTMLElement, event: React.WheelEvent, rowHeight: number) => {
  // Shift + wheel scrolls horizontally, natively
  if (event.shiftKey) return;
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? rowHeight
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? list.clientHeight : 1;
  list.scrollBy({ top: event.deltaY * unit });
};

/** A word of a line: character range `[start, end)` in its displayed text, and its highlight color */
type Word = { start: number; end: number; color?: string };

// The backend emits flat `<span style="color:...;">` tags around highlighted text, see to_html
const HTML_RUN = /<span style="color:([^"]*?);">([^<]*)<\/span>|([^<]+)/g;

const wordsCache = new WeakMap<SerialMessage, Word[]>();

/** Words of a line with their highlight color; cached per line, as lines never change */
const lineWords = (line: SerialMessage): Word[] => {
  let words = wordsCache.get(line);
  if (words === undefined) {
    words = [];
    let position = 0;
    for (const run of line.message.matchAll(HTML_RUN)) {
      const color = run[1] === undefined ? undefined : unescapeHtml(run[1]);
      const text = unescapeHtml(run[2] ?? run[3]);
      for (const word of text.matchAll(/\S+/g)) {
        const start = position + (word.index ?? 0);
        words.push({ start, end: start + word[0].length, color });
      }
      position += text.length;
    }
    wordsCache.set(line, words);
  }
  return words;
};

/**
 * Position of the minimap for the current scroll of the list. Each terminal row is `ratio` times
 * smaller in the minimap. When the minimap is taller than `height`, it scrolls with the list so that
 * its top shows the top of the log, and its bottom the bottom, as in VS Code.
 */
const minimapGeometry = (list: HTMLDivElement, height: number, ratio: number) => {
  const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
  const overflow = Math.max(0, list.scrollHeight * ratio - height);
  // Minimap y shown at the top of the canvas
  const offset = maxScroll > 0 ? list.scrollTop / maxScroll * overflow : 0;
  const sliderHeight = list.clientHeight * ratio;
  const sliderTop = list.scrollTop * ratio - offset;
  // List scroll for a slider move of 1px
  const dragScale = overflow > 0 ? maxScroll / Math.max(1, height - sliderHeight) : 1 / ratio;
  return { offset, sliderTop, sliderHeight, dragScale };
};

/** Lets the terminal redraw the minimap when its list scrolls */
export type LogMinimapHandle = {
  redraw: () => void;
};

interface LogMinimapProps {
  ref?: Ref<LogMinimapHandle>;
  lines: SerialMessage[];
  // List of the terminal, scrolled by the minimap
  listApiRef: RefObject<ListImperativeAPI | null>;
  // Height of a terminal row, in px
  rowHeight: number;
  selectedLineId?: number | null;
  search?: RowSearch;
}

/** Overview of the log next to a terminal: click or drag to scroll the terminal */
const LogMinimap: React.FC<LogMinimapProps> = ({ ref, lines, listApiRef, rowHeight, selectedLineId, search }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const drawRef = useRef<() => void>(() => undefined);
  const isSliderHoveredRef = useRef(false);
  const dragRef = useRef<{ startY: number; startScrollTop: number; scale: number } | null>(null);
  const ratio = MINIMAP_ROW_HEIGHT / rowHeight;

  // Lines hidden by a remove rule have no height in the terminal, so they are left out
  const shownIndices = useMemo(() => {
    const indices: number[] = [];
    lines.forEach((line, index) => {
      if (!line.removed_line) indices.push(index);
    });
    return indices;
  }, [lines]);

  // Draws at most once per frame, however many scroll events or renders happen in it
  const scheduleDraw = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      drawRef.current();
    });
  }, []);

  // Only the lines in view are drawn, so a few hundred whatever the log length
  const draw = () => {
    const canvas = canvasRef.current;
    const list = listApiRef.current?.element;
    const context = canvas?.getContext('2d');
    if (!canvas || !list || !context) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const pixelRatio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.fillStyle = MINIMAP_BACKGROUND;
    context.fillRect(0, 0, width, height);

    const { offset, sliderTop, sliderHeight } = minimapGeometry(list, height, ratio);
    const first = Math.max(0, Math.floor(offset / MINIMAP_ROW_HEIGHT));
    const last = Math.min(shownIndices.length - 1, Math.ceil((offset + height) / MINIMAP_ROW_HEIGHT));
    const xOf = (character: number) => MINIMAP_LEFT_PADDING + character * MINIMAP_CHAR_WIDTH;

    for (let row = first; row <= last; row++) {
      const index = shownIndices[row];
      const line = lines[index];
      const y = row * MINIMAP_ROW_HEIGHT - offset;

      // A marker is drawn as a bar across the minimap, so it stands out like in the terminal
      if (line.marker) {
        context.fillStyle = MARKER_COLOR;
        context.fillRect(0, y, width, MINIMAP_ROW_HEIGHT);
        continue;
      }
      if (line.id === selectedLineId) {
        context.fillStyle = SELECTED_ROW_COLOR;
        context.fillRect(0, y, width, MINIMAP_ROW_HEIGHT);
      }
      const ranges = search ? lineRanges(line, search.regex) : [];
      if (ranges.length > 0) {
        context.fillStyle = SEARCH_ROW_COLOR;
        context.fillRect(0, y, width, MINIMAP_ROW_HEIGHT);
      }

      context.globalAlpha = TEXT_ALPHA;
      for (const word of lineWords(line)) {
        if (xOf(word.start) >= width) break;
        // An invalid color is ignored by the canvas, so the text color is set first
        context.fillStyle = TEXT_COLOR;
        if (word.color) context.fillStyle = word.color;
        context.fillRect(xOf(word.start), y, (word.end - word.start) * MINIMAP_CHAR_WIDTH, MINIMAP_ROW_HEIGHT);
      }
      context.globalAlpha = 1;

      ranges.forEach(([start, end], occurrence) => {
        const isCurrent = search?.current?.line === index && search.current.occurrence === occurrence;
        context.fillStyle = isCurrent ? SEARCH_CURRENT_COLOR : SEARCH_MATCH_COLOR;
        // At least 2px wide, so a single character match is visible
        context.fillRect(xOf(start), y, Math.max(2, (end - start) * MINIMAP_CHAR_WIDTH), MINIMAP_ROW_HEIGHT);
      });
    }

    context.fillStyle = dragRef.current ? SLIDER_DRAG_COLOR : isSliderHoveredRef.current ? SLIDER_HOVER_COLOR : SLIDER_COLOR;
    context.fillRect(0, sliderTop, width, sliderHeight);
  };

  // The latest draw sees the latest props; any render may change what is drawn
  useLayoutEffect(() => {
    drawRef.current = draw;
    scheduleDraw();
  });

  // Redrawn when the list scrolls, through this handle, and when the minimap is resized
  useImperativeHandle(ref, () => ({ redraw: scheduleDraw }), [scheduleDraw]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [scheduleDraw]);

  // Pointer position relative to the canvas, and the minimap geometry for it
  const pointerGeometry = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const list = listApiRef.current?.element;
    if (!list) return undefined;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const geometry = minimapGeometry(list, rect.height, ratio);
    const isOnSlider = y >= geometry.sliderTop && y < geometry.sliderTop + geometry.sliderHeight;
    return { list, y, geometry, isOnSlider };
  };

  // Dragging the slider scrolls the list; a click elsewhere first centers the clicked line, then
  // drags from there, as in VS Code
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const pointer = pointerGeometry(event);
    if (!pointer) return;
    const { list } = pointer;
    if (!pointer.isOnSlider) {
      list.scrollTo({ top: (pointer.y + pointer.geometry.offset) / ratio - list.clientHeight / 2 });
    }
    const { dragScale } = minimapGeometry(list, event.currentTarget.clientHeight, ratio);
    dragRef.current = { startY: event.clientY, startScrollTop: list.scrollTop, scale: dragScale };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    scheduleDraw();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const list = listApiRef.current?.element;
    if (drag && list) {
      list.scrollTo({ top: drag.startScrollTop + (event.clientY - drag.startY) * drag.scale });
      return;
    }
    const isOnSlider = pointerGeometry(event)?.isOnSlider ?? false;
    if (isOnSlider !== isSliderHoveredRef.current) {
      isSliderHoveredRef.current = isOnSlider;
      scheduleDraw();
    }
  };

  const endDrag = () => {
    dragRef.current = null;
    scheduleDraw();
  };

  return (
    <Box sx={{ width: MINIMAP_WIDTH, flexShrink: 0, height: '100%', borderLeft: '1px solid #333' }}>
      <canvas
        ref={canvasRef}
        aria-hidden
        style={{ display: 'block', width: '100%', height: '100%' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          isSliderHoveredRef.current = false;
          scheduleDraw();
        }}
        // The minimap itself does not scroll: the wheel scrolls the list
        onWheel={(event) => {
          const list = listApiRef.current?.element;
          if (list) scrollByWheel(list, event, rowHeight);
        }}
      />
    </Box>
  );
};

export default LogMinimap;
