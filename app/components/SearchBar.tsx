'use client';

import React, { type Ref } from 'react';
import Paper from '@mui/material/Paper';
import InputBase from '@mui/material/InputBase';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CloseIcon from '@mui/icons-material/Close';
import { type LogSearch } from '../hooks/useLogSearch';
import { buildSearchRegex } from '../utils/search';

interface SearchBarProps {
  search: LogSearch;
  inputRef: Ref<HTMLInputElement>;
}

/** Toggle shown as a short label, highlighted when on, like in code editors */
const ToggleButton: React.FC<{ label: string; title: string; on: boolean; onToggle: () => void }> = ({ label, title, on, onToggle }) => (
  <Tooltip title={title} placement="bottom" arrow>
    <IconButton
      size="small"
      aria-label={title}
      aria-pressed={on}
      onClick={onToggle}
      sx={{
        width: 28,
        height: 28,
        borderRadius: 1,
        fontFamily: 'monospace',
        fontSize: '0.8rem',
        color: on ? 'primary.main' : 'text.secondary',
        border: '1px solid',
        borderColor: on ? 'primary.main' : 'transparent',
      }}
    >
      {label}
    </IconButton>
  </Tooltip>
);

/** Search bar of the main terminal: Enter / Shift+Enter go to the next / previous match, Escape closes */
const SearchBar: React.FC<SearchBarProps> = ({ search, inputRef }) => {
  const { options, setOptions, matches, currentIndex } = search;
  const isInvalid = options.query !== '' && buildSearchRegex(options) === null;

  return (
    <Paper
      elevation={4}
      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, pl: 1, pr: 0.5, py: 0.5, bgcolor: '#252526', border: '1px solid #333' }}
    >
      <InputBase
        inputRef={inputRef}
        autoFocus
        placeholder="Search"
        value={options.query}
        onChange={(e) => setOptions({ ...options, query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) search.previous();
            else search.next();
          } else if (e.key === 'Escape') {
            search.close();
          }
        }}
        sx={{
          width: 220,
          fontFamily: 'monospace',
          fontSize: '0.875rem',
          px: 0.5,
          border: '1px solid',
          borderColor: isInvalid ? 'error.main' : '#3c3c3c',
          borderRadius: 1,
        }}
      />
      <ToggleButton label="Aa" title="Match case" on={options.caseSensitive}
        onToggle={() => setOptions({ ...options, caseSensitive: !options.caseSensitive })} />
      <ToggleButton label=".*" title="Use regular expression" on={options.regex}
        onToggle={() => setOptions({ ...options, regex: !options.regex })} />
      <Typography
        variant="caption"
        sx={{ minWidth: 64, textAlign: 'center', color: options.query !== '' && matches.length === 0 ? 'error.main' : 'text.secondary' }}
      >
        {options.query === '' ? '' : isInvalid ? 'Invalid regex' : matches.length === 0 ? 'No results' : `${currentIndex + 1} / ${matches.length}`}
      </Typography>
      <Tooltip title="Previous match (Shift+Enter)" placement="bottom" arrow>
        <span>
          <IconButton size="small" aria-label="previous match" onClick={search.previous} disabled={matches.length === 0}>
            <KeyboardArrowUpIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Next match (Enter)" placement="bottom" arrow>
        <span>
          <IconButton size="small" aria-label="next match" onClick={search.next} disabled={matches.length === 0}>
            <KeyboardArrowDownIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Close (Escape)" placement="bottom" arrow>
        <IconButton size="small" aria-label="close search" onClick={search.close}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Paper>
  );
};

export default SearchBar;
