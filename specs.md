# KazeSerial — Application Specifications

## Overview

KazeSerial is a desktop serial terminal application built with **Tauri v2** (Rust backend) and **Next.js / React** (frontend), using **Material UI (MUI)** as the component library. It allows users to monitor serial port output or follow a log file, apply color highlight/filter rules, export logs, and expose the log buffer to an AI agent through an embedded MCP server.

The app uses a **dark theme** throughout.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri v2 |
| Frontend framework | Next.js (static export) |
| UI component library | Material UI (MUI) v5, dark theme |
| Virtualized list | `react-window` (custom fork with `rowComponent` API) |
| Resizable panels | `re-resizable` |
| Backend language | Rust |
| Serial port | `serialport` crate |
| Regex engine | `regex` crate |
| Async runtime | Tokio |
| Persistence | `tauri-plugin-fs` (AppConfig directory) |
| File dialogs | `tauri-plugin-dialog` |
| Local time (log files) | `chrono` crate |

---

## Layout

The main window (default 1600×1200, resizable) is divided horizontally into two panes.

### Terminals pane (left, fills all remaining width)
A vertical flex column containing:

1. **Main Serial Terminal** (top, default ~70% height, vertically resizable)
   - Displays all incoming log lines
   - [Minimap](#minimap) on the right edge, unless disabled in the [Config tab](#config-tab)
   - Toolbar (top-right overlay, left of the minimap, left to right):
     - **Search** (magnifier icon) — opens or closes the [search bar](#search) (also Ctrl+F); highlighted in blue while open
     - **Auto-scroll toggle** (arrow-down icon) — enables/disables auto-scroll
     - **Insert marker** (bookmark icon) — appends a [marker line](#markers) (also Ctrl+M)
     - **Save** (save icon) — saves the main log to a `.log` file
     - **Delete** (delete icon) — clears the main log and the backend [log store](#log-store), so MCP clients see the same log. Ctrl+Shift+R also clears the focus log
     - **More** (three-dot icon, rightmost) — dropdown menu with demo utilities:
       - *Demo - Append 10k logs*
       - *Demo - Regenerate logs*
   - [Send bar](#send-bar) at the bottom, under the log

2. **"focus" label** — small monospace label with top border, always visible even when the focus panel is collapsed

3. **Focus Serial Terminal** (bottom, fills remaining height, collapsible)
   - Displays only lines that matched a highlight rule with `focus = true`
   - Toolbar (top-right overlay, left to right):
     - **Auto-scroll toggle** (arrow-down icon)
     - **Save** (save icon) — saves the focus log to a `.log` file
     - **Delete** (delete icon) — clears the focus log

#### Focus panel collapse button
A circular toggle button (36×36px, MUI `IconButton`) straddles the top border of the focus section (centered horizontally, `position: absolute`, `top: -18px`). It uses:
- `LastPage` icon rotated 90° when the focus panel is open (points downward = "collapse")
- `FirstPage` icon rotated 90° when the focus panel is closed (points upward = "expand")

When the focus panel is closed, the Main Terminal wrapper takes `flex: 1` to fill all available space above the "focus" label. When open, the wrapper uses `display: contents` so it is transparent to the flex layout and the Resizable component behaves as a direct child of the Container.

### Settings pane (right, collapsible)
A **Control Panel** made of three tabs: **Source** (data source selection), **Highlight** (highlight rules) and **Config** (application settings). See [Control Panel](#control-panel) for details. It is resizable from its **left edge** via `re-resizable` (default width ~30%, min 220px, max 70%) and can be collapsed to a thin strip.

#### Settings panel collapse button
A circular toggle button (36×36px) is positioned absolutely on the **right border** of the terminals pane (`right: -18px`, `top: 50%`), straddling the boundary between the two panes. It uses:
- `LastPage` icon when the settings panel is open (points right = "collapse")
- `FirstPage` icon when the settings panel is closed (points left = "expand")

When the settings panel is closed, a thin strip with a vertical "Settings" label (one character per line) replaces the full panel. Clicking the strip or the button reopens the panel.

The terminals pane uses `position: relative` on its outer Box with `overflow: hidden` on an inner Box, so the toggle button (which overflows at `right: -18px`) is not clipped by the terminal content.

---

## Serial Terminal Component

### Behavior
- Uses a virtualized list (`react-window`) for performance with large log counts
- Each row is 20px tall. Lines with `removed_line = true` get no row: the page keeps the indices of these hidden lines for each terminal (`TerminalRows` in `utils/terminalRows.ts`, built by `hooks/useTerminalRows.ts`) and the terminal maps rows to line indices, so line numbers, timestamps, search matches and scrolling still use positions in the log. With rows of a single height, the list finds the rows in view without measuring the rows above them, so a render costs the same whatever the log length. The terminal gets the lines only through `TerminalRows`, whose fields are private: in development, React compares the old and new props of each rendered component property by property, which walked the whole log for each row
- Log text is rendered as HTML via `dangerouslySetInnerHTML` to support `<span style="color:...">` highlight markup. The backend escapes the log text, so only its own `<span>` tags are interpreted (see [Highlight processing pipeline](#highlight-processing-pipeline-process_line))
- Font: monospace, 0.875rem, color `#d4d4d4`, background `#1e1e1e`
- Rows are as wide as their content (`width: max-content`, at least the terminal width), so the sticky gutter (line numbers, timestamps) stays visible on long lines

### Line numbers
Enabled by the **Show line numbers** setting of the [Config tab](#config-tab). Like in a code editor, a gutter on the left of each row shows its line number.

- **Main terminal**: the position of the line in the main log, starting at 1. Lines hidden by a `remove` + `whole_line` rule are counted, so the numbering skips them and a number always designates the same line whatever the rules. It restarts at 1 when the log is cleared or replaced by an opened file; Refresh keeps the same numbers.
- **Focus terminal**: the number of the same line in the main log, found by id (binary search, since ids increase along the log, with a linear search as fallback). Markers are skipped by the binary search, since a marker inserted above a line has a larger id than the lines around it. Empty when that line is no longer in the main log.
- **Rendering**: the number is CSS generated content (`::before { content: attr(data-line-number) }`), so it is neither selectable nor part of copied text, and Save never includes it. The gutter is right-aligned, gray (`#545a62`), as wide as the largest number of the main log plus 2 characters, and `position: sticky` on the left with an opaque background so text scrolled horizontally passes under it. It follows the selected and hovered row highlights.
- **Separate gutter boxes**: the line number and the timestamp are two sibling sticky boxes, never one shared container. WebKit (the Tauri webview on Linux) fills the selection gap before selected text up to the start of its box: with a selectable timestamp in the same box, a multi-line selection painted over the line number. Copied text was not affected.
- The terminal receives it through an optional `lineNumbers` prop (`{ numberOf(index), digits }`); without it, no gutter is rendered.

### Timestamps
Enabled by the **Show timestamps** setting of the [Config tab](#config-tab). Shows the reception time of each line in the gutter, after the line number.

- **Reception time**: set by the backend in the `timestamp` field (ms since the Unix epoch) when the line is received:

  | Source | Timestamp |
  |---|---|
  | Serial port | when the line terminator is read (non-ASCII byte messages: when the byte is read) |
  | Followed file, appended lines | when the line is detected |
  | System messages | when emitted |
  | Demo append (`append_logs_line`) | when appended |
  | Opened file (`open_file`), initial content of a followed file, Demo regenerate | none (`null`), the real time is unknown |

- **Refresh** keeps the timestamps: the log store records them with the lines it reprocesses.
- **Focus terminal**: a focus line is the same message, so it shows the same time.
- **Only after inactivity**: a line shows its timestamp only if the previous line of the same terminal arrived at least the delay earlier (default 500 ms), or has no timestamp. Each line restarts the delay, so a steady flow of lines closer than the delay shows a single timestamp, on its first line. The gap is measured within each terminal: in the focus terminal, from the previous focus line. Lines hidden by a `remove` + `whole_line` rule count as activity. Implemented by `isTimestampShown` in `utils/timestamp.ts`, shared by the display and Save.
- **Format**: local time, formatted with the **Format** setting (`formatTimestamp` in `utils/timestamp.ts`), `HH:mm:ss` by default. A format is a pattern where these codes are replaced and any other character is kept as is:

  | Code | Value | Code | Value |
  |---|---|---|---|
  | `YYYY` | year, 4 digits | `HH` | hours, 00–23 |
  | `MM` | month, 01–12 | `mm` | minutes |
  | `DD` | day of month | `ss` | seconds |
  | | | `SSS` | milliseconds |

  Codes are case-sensitive (`MM` month, `mm` minutes) and there is no escaping, so a code inside a word is replaced too (the `ss` of `pass`). An empty pattern falls back to the default. All codes are fixed-width, so the column width is the length of the formatted pattern (`timestampWidth`), plus one character for the separating space; it is empty for lines without timestamp.
- System messages also carry their time in their text, `[HH:MM:SS]` in local time: the same time as their timestamp in the gutter.
- **Display only** (default): the timestamp is CSS generated content, like the line number: not selectable, not copied, not saved.
- **In text** (**Include timestamps in copied and saved text**): the timestamp column is real text, so it is selectable and copied: the timestamp followed by a space (`HH:mm:ss.SSS line`), or blanks of the column width when the line shows no timestamp (missing or hidden by the inactivity option), so copied lines stay aligned as on screen. Save writes the same column on every line, in both terminals (`timestampColumnText` in `utils/timestamp.ts`). The line number stays out of the selection and the copied text.
- The terminal receives it through an optional `timestamps` prop (`{ inText, inactivityMs?, format, width }`); `inactivityMs` is set only when **Only after inactivity** is checked, `width` is the formatted width of `format`.

### New line highlight
Enabled by the **Highlight new lines** setting of the [Config tab](#config-tab). A line appears with a background tint that fades out over the configured duration (default 3 s, color `#7896b429`: a desaturated blue at 16 % opacity).

- **Which lines**: lines **appended** to the view, in both terminals: serial port, followed file, system messages, demo append (`serial-data` and `*-append` events). The frontend stamps them with `arrivedAt` (`Date.now()`) when appending. Lines **replacing** the log (file open, Refresh, follow start, demo regenerate) are not stamped, so a whole file never flashes.
- **Fade**: a Web Animations API animation of an inset `box-shadow` (`inset 0 0 0 100vmax COLOR` → `transparent`, `ease-out`), so it is painted over the row background without hiding the selection highlight. The opaque gutter (line numbers, timestamps) is not tinted.
- **Virtualized rows**: rows only exist while visible, so the animation starts with a negative delay equal to the time elapsed since `arrivedAt`. A row scrolled back into view mid-fade resumes where the fade is, and a line first seen after the duration is not highlighted. The animation is cancelled when the row is unmounted or the setting changes.
- The terminal receives it through an optional `arrival` prop (`{ durationMs, color }`).

### Search
Search in the main terminal, like the find widget of a code editor.

- **Opening**: Ctrl+F or the toolbar **Search** button. The bar appears at the top right of the main terminal, under the toolbar. Ctrl+F on an open bar focuses and selects its text. The search is kept when the bar is closed and reopened.
- **Bar** (`SearchBar`): query field, **Aa** (match case, off by default) and **.\*** (regular expression, JavaScript syntax) toggles, a counter (`current / total`, `No results`, or `Invalid regex` with a red field border), previous / next buttons, close button.
- **Keyboard**: Enter goes to the next match, Shift+Enter to the previous one (both wrap around), Escape closes the bar.
- **Searched text**: the displayed text of each line of the main log, i.e. the message without the highlight tags, unescaped (`displayText`): text removed by `remove` rules is not searched, `<` and `&` are. Line numbers and timestamps are not part of it. Lines hidden by a `remove` + `whole_line` rule are skipped. Empty regex matches (e.g. `a*`) are ignored.
- **Navigation**: changing the query or a toggle goes to the first match; next / previous go to the following one. Going to a match scrolls its line to the center of the terminal and disables auto-scroll, so new lines do not pull the view away. The current match index is clamped when lines disappear (Clear, Refresh).
- **Highlighting**: every match gets a yellow background (`rgba(230,190,60,0.35)`), the current one orange (`rgba(255,140,0,0.9)`, dark text). It uses the CSS Custom Highlight API (`CSS.highlights`): each visible row adds DOM ranges for its matches to the shared `search-match` / `search-current` highlights and removes them when unmounted, so the line HTML and the colors of the highlight rules are untouched. The `::highlight()` styles are injected at runtime on first use, because the build CSS parser (Turbopack) does not support this pseudo-element yet. Without API support, navigation still works but nothing is highlighted.
- **Performance**: match ranges are cached per line and regex (`lineRanges`, `WeakMap` keyed by message), so when lines arrive only the new ones are scanned. The match list is rebuilt from the cache on every log change while the bar is open.
- **Scope**: the main terminal only, not the focus terminal.

### Markers
A marker is a numbered line inserted by the user to delimit a part of the log, e.g. a reproduction attempt.

- **Insertion**: Ctrl+M or the toolbar **Insert marker** button calls `add_marker`, which appends `----- MARK n -----` at the end of the log (`n` starts at 1 and increases with each marker; clearing the logs, with the Clear button, Ctrl+Shift+R or the MCP `clear_logs` tool, starts it again at 1). The line gets a reception timestamp.
- **Insertion above a line**: hovering a row of the main terminal shows an **Insert a marker above** button (bookmark icon, marker color) at the height of that row. It is a single button over the list, 20px from its right edge (left of the [minimap](#minimap) when shown) so it stays clear of the vertical scrollbar, and horizontal scrolling does not move it. The row is the one at the pointer height, also where a short row does not reach when scrolled horizontally; it is updated when the pointer moves, on scroll and when the lines change. Clicking it calls `insert_marker` and inserts the marker just above that line, without selecting the row. The marker takes the next number, so numbers follow the insertion order, not the log order. It gets the timestamp of the line above it (none above the first line), so it does not change which timestamps are shown. In the focus terminal it goes after the closest focus line above it in the main log, or else before the closest one below it. Its id is new, so larger than the ids of the lines around it, see [log store](#log-store).
- **Style**: bold violet text (`#c586c0`) on a light tint of it (`rgba(197,134,192,0.12)`), unless the row is selected.
- **Behavior**: a marker is not processed by the highlight rules (`marker_payload`, text HTML-escaped). It is flagged `matched`, so it also appears in the focus terminal and delimits the focus lines. It is recorded in the log store (visible to MCP clients) and written by Save like any line. Refresh keeps markers as markers: the log store records the marker flag. To go back to a marker, search for `MARK`.

### Send bar
`SendBar` component, under the main terminal, sends text to the serial port.

- **Layout** (left to right): monospace text field, **line ending** select (`None`, `LF`, `CR`, `CRLF`, default `LF`, saved as `sendLineEnding` in `app_config.json`), **Send** button (send icon).
- **Sending**: Enter or the Send button calls `send_serial` with the text, sent as is (UTF-8, no escape sequences), followed by the chosen line ending. An empty text sends the line ending alone, e.g. to get a prompt back. The field is cleared once sent; on failure the text is kept to send it again, and the failure is shown in the log as a [system message](#system-messages).
- **History**: Up / Down recall the texts sent since launch (at most 100, kept in memory only, an empty text or the same text as the previous one is not added), as in a shell. Down past the most recent text restores the text being edited.
- **Connection**: the bar is enabled only while the serial port is open, following the `serial-connection` event; otherwise it is disabled and shows `Not connected` (no port, file opened or followed, port lost and waiting to come back).
- **Sent lines**: each text sent is appended to the log as `>> {text}` (`sent_payload`) just before it is written to the port, so the reply of the device comes after it. Like a [marker](#markers), it is not processed by the highlight rules (text HTML-escaped), is flagged `matched` so it also appears in the focus terminal, is recorded in the log store (visible to MCP clients) and written to the [log files](#log-files), and Refresh keeps it as a sent line (the log store records the sent flag). Shown in teal (`#4ec9b0`).

### Minimap
Enabled by the **Show minimap** setting of the [Config tab](#config-tab) (on by default). Like in VS Code, an 80px wide overview of the main log on the right edge of the main terminal (`LogMinimap`).

- **Content**: each line is 2px tall and each character 1px wide, starting 4px from the left edge. Words (runs of non-space characters) are drawn as blocks in the color of their highlight rule, or `#d4d4d4` without one, at 60% opacity; characters beyond the minimap width are not drawn. The colors come from the line HTML (`<span style="color:...;">` runs built by the backend), parsed once per line and cached (`WeakMap` keyed by message). Lines hidden by a `remove` + `whole_line` rule are left out, as in the terminal. The minimap uses the rows of the terminal, which keeps the indices of these hidden lines (`utils/terminalRows.ts`), so a new line appended to the log only scans itself, instead of the whole log.
- **Markers**: a [marker](#markers) is a full-width bar in the marker color (`#c586c0`).
- **Selected line**: a full-width white tint (`rgba(255,255,255,0.25)`).
- **Search matches**: while the [search bar](#search) is open, a line with matches gets a full-width yellow tint (`rgba(230,190,60,0.25)`) and each match a block (`rgba(230,190,60,0.9)`, the current one orange `rgb(255,140,0)`), at least 2px wide. Ranges come from the search cache (`lineRanges`).
- **Scale and scrolling**: a terminal row (20px) is 10 times smaller in the minimap. While the whole log fits in the minimap height, it is drawn from the top. Otherwise the minimap scrolls with the terminal, proportionally: its top shows the start of the log when the terminal is at the top, its bottom the end of the log when the terminal is at the bottom.
- **Slider**: a gray overlay (`rgba(121,121,121,0.2)`, lighter on hover and while dragged) over the part of the log visible in the terminal.
- **Interactions**: dragging the slider scrolls the terminal so that the slider follows the pointer. Pressing elsewhere centers the clicked line in the terminal, then drags from there. The wheel over the minimap scrolls the terminal. Like a manual scroll, scrolling away from the bottom disables [auto-scroll](#auto-scroll). The row under the pointer is not highlighted while the pointer is over the minimap.
- **Vertical scrollbar**: hidden while the minimap is shown, since the slider gives the same information; the horizontal scrollbar stays. The list gets `overflow-y: hidden` (`overflow-x: auto`), so it no longer scrolls vertically by itself: the wheel over it scrolls it (`scrollByWheel`, pixel, line or page deltas; Shift + wheel is left to the native horizontal scroll). CSS cannot hide only the vertical scrollbar in every webview: `scrollbar-width: none` also hides the horizontal one, `::-webkit-scrollbar { width: 0 }` is ignored by WebView2 (Windows), which applies the standard `scrollbar-width: thin` of `globals.css` instead. Making the list wider than a clipping container by the measured scrollbar width was tried first: it works with classic scrollbars, but the scrollbar stayed visible in WebKitGTK (Linux), most likely an overlay scrollbar drawn over the content, which has no width to measure.
- **Rendering**: a `<canvas>` sized for the device pixel ratio. Only the lines in view are drawn (a few hundred whatever the log length), at most once per animation frame: on terminal scroll (the terminal calls a `redraw` handle from its `onScroll`), on minimap resize, and on every render of the terminal (new lines, search, selection). About 3ms per draw with 200,000 lines.
- **No library**: existing minimap packages target a specific editor or canvas (CodeMirror, React Flow, CKEditor...), or clone the DOM, which does not work with a virtualized list.
- **Scope**: the main terminal only, not the focus terminal.

### Auto-scroll
- When enabled, the list automatically scrolls to the last row when new logs arrive
- Scrolling up manually disables auto-scroll (detected when `scrollHeight - clientHeight - scrollTop > 30`)
- Scrolling back to the bottom re-enables it
- A debounce ref (`ignoreScrollUntilRef`) prevents false disables when programmatically scrolling

### Line selection / highlight
- Clicking a line highlights the entire row with `rgba(255,255,255,0.12)` background
- The row under the pointer is highlighted more lightly, with `rgba(255,255,255,0.06)` layered over its background (so a marker keeps its tint), in both terminals; a selected row keeps only the selection highlight. The row is the one at the pointer height (see [Markers](#markers)), so it stays highlighted while the pointer is over the insert marker button. The line number and timestamp gutter follow it
- Clicking the same line again deselects it
- Text selection (copy-paste) is preserved: if `window.getSelection().toString()` is non-empty when `mouseup/click` fires, the click is ignored
- The selected line ID can be controlled externally via a `selectedLineId` prop (used by the focus panel)
- **Copy-paste with newlines**: an `onCopy` handler on the terminal Box intercepts clipboard writes. It iterates over rendered `.serial-terminal-row` elements, clips each to the selection range, and joins the resulting strings with `\n`. This ensures that multi-line selections paste with proper line breaks, working around the fact that `react-window` uses `position: absolute` rows (which the browser does not separate with newlines on its own).

### Focus panel click behavior
- Clicking a line in the **focus panel** scrolls the **main panel** to the corresponding line (matched by `id`) using `align: "center", behavior: "smooth"`
- The corresponding line in the main panel is also highlighted

---

## Serial Message Type

```typescript
type SerialMessage = {
  id: number;           // unique monotonically increasing ID
  message: string;      // escaped HTML string (may contain <span> tags)
  matched: boolean;     // true if matched a focus rule
  rawline?: string;     // original unprocessed line (present if a rule matched or message differs from it)
  removed_line?: boolean; // true if the whole line was removed
  timestamp?: number | null; // reception time in ms since the Unix epoch, null when unknown (opened file)
  arrivedAt?: number;   // frontend time an appended line was added to the view, for the new line highlight
  marker?: boolean;     // marker line inserted by the user (Ctrl+M)
  sent?: boolean;       // text sent to the serial port by the user, see Send bar
};
```

---

## Control Panel

A panel on the right side with a row of full-width tabs (MUI `Tabs`). The tabs occupy the full height of the panel, and the content of the active tab scrolls vertically.

| Tab | Content |
|---|---|
| **Source** (default) | The data source tabs, see [Source tab](#source-tab) |
| **Highlight** | The `HighLighSettings` rules table, see [Highlight Settings Component](#highlight-settings-component) |
| **Config** | Application settings, see [Config tab](#config-tab) |

### Source tab
Select the data source, with its own row of tabs: smaller than the main tabs (36px high, 13px labels) and aligned on the left, the labels in line with the panel content.

| Tab | Content |
|---|---|
| **Serial** (default) | Serial port configuration, see below |
| **File** | File follow (`tail -f`), see below |

#### Serial tab
Serial port configuration:
- **Port selector** — dropdown listing available ports with auto-detection on mount. Each entry shows `portName - deviceLabel` (manufacturer + product name for USB, or generic label). A refresh button re-lists ports.
- **Baud rate selector** — dropdown with values: 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600. Default: 115200.
- **Connect / Disconnect button** — on the same row as the baud rate selector. Calls `open_port` or `close_port` Tauri command. The button state (`isConnected`) is set to `true` only in the `.then()` callback of `open_port`, and to `false` in the `.then()` callback of `close_port` or upon receiving a `serial-disconnected` event. This ensures the button accurately reflects the actual connection state even when the port is lost unexpectedly. The **Auto-reconnect serial port** setting of the [Config tab](#config-tab) is passed to `open_port` on Connect.
- **Waiting status** — with auto-reconnect, when the port is lost, the button stays on **Disconnect** (which cancels the wait) and a warning caption *Port lost, waiting for it to come back…* is shown until `serial-reconnected` is received; the port it carries is then selected, as a USB device may come back under another name.

#### File tab
`FileSettings` component, two rows:
1. **Select button** (folder icon) and **File field**:
   - **Select button** — opens a file picker and shows the chosen path in the field. It neither opens nor follows the file.
   - **File field** — read-only, shows the chosen path, truncated with an ellipsis; the full path is shown on hover.
2. **Open** and **Follow / Stop** buttons, sharing the width:
   - **Open** — calls `open_file`: the file is read once and its lines replace the logs. Read and split like a followed file, except that the last line is kept even without a trailing newline.
   - **Follow / Stop** — calls `watch_file` with the chosen path, or `stop_file_watch`. The button state (`isFileWatching`) is set to `true` only in the `.then()` callback of `watch_file`, and to `false` on Stop or upon receiving a `file-watch-stopped` event.

Open and Follow are disabled until a file is chosen. While following, the select button, the file field and Open are disabled (following would keep appending to an opened file). See [File Follow](#file-follow-tail--f) for the backend behavior.

### Config tab
`ConfigSettings` component, a list of application settings in four groups, each starting with a small title (`SectionTitle` component: MUI `overline` text, secondary color): **Display** (from *Show line numbers* to *Highlight new lines*), **Serial** (*Auto-reconnect serial port*), **Log files** (from *Save logs to files* to *Max lines per file*) and **MCP server** (*Enable MCP server* and *Port*).

| Setting | Default | Effect |
|---|---|---|
| **Show line numbers** (checkbox) | off | Shows a [line number gutter](#line-numbers) in the main and focus terminals |
| **Show minimap** (checkbox) | on | Shows the [minimap](#minimap) on the right of the main terminal, and hides its vertical scrollbar |
| **Show timestamps** (checkbox) | on | Shows the [reception time](#timestamps) of each line in the main and focus terminals |
| **Include timestamps in copied and saved text** (checkbox, indented) | off | Makes the timestamp column selectable and part of copied and saved text. Disabled while timestamps are hidden |
| **Only after inactivity** (checkbox, indented) + **Delay (ms)** (number field) | on, 500 | Only shows a timestamp on a line arriving after the delay without any line, see [Timestamps](#timestamps). The field is disabled while the checkbox is off; it accepts integers ≥ 0, saves valid values as typed and shows the saved value again when it loses focus (`IntegerField`) |
| **Format** (select, indented) | `HH:mm:ss` | Timestamp format: `HH:mm:ss`, `HH:mm:ss.SSS`, `YYYY-MM-DD HH:mm:ss.SSS` or **Custom…**, which shows a **Pattern** field with the available codes and a preview. *Custom* stays selected while editing, even if the pattern matches a preset. See [Timestamps](#timestamps) for the codes |
| **Highlight new lines** (checkbox) + **Duration (ms)** (`IntegerField`) + color button | on, 3000, `#7896b429` | Highlights lines as they arrive, fading out over the duration, see [New line highlight](#new-line-highlight). The color button opens a picker with an alpha slider (`ColorPickerButton` with `alpha`), the alpha setting how visible the highlight is. Duration and color are disabled while the checkbox is off |
| **Auto-reconnect serial port** (checkbox) | on | When the serial port is lost (device reset, unplugged, reflashed), waits for it to come back and reopens it instead of disconnecting, see [`open_port`](#open_portport_name-port_description-baud_rate-auto_reconnect). Applied on the next Connect |
| **Save logs to files** (checkbox) | on | Saves the serial log to files as it arrives, see [Log Files](#log-files). A caption under it summarizes what is written. Disables the settings below while off |
| **Folder** (read-only field, indented) + **Choose…** + **Default** buttons | default folder | Folder of the log files. Shows the default folder (given by `get_default_log_folder`, with a *Default folder* caption) until one is chosen with **Choose…** (folder dialog). **Default** (shown only when a folder is chosen) goes back to the default folder |
| **Rotate files** (checkbox, indented) | on | Starts a new file when the current one is full, and deletes the oldest files beyond the maximum |
| **Max files** + **Max lines per file** (`IntegerField`, indented twice) | 10, 10 000 | Rotation limits, integers ≥ 1. Disabled while rotation is off |
| **Enable MCP server** (checkbox) | off | Starts or stops the [MCP server](#mcp-server) with `start_mcp_server` / `stop_mcp_server`. Reflects the real server state, read with `get_mcp_status` on mount (the server survives webview reloads and can be started by `KAZESERIAL_MCP_PORT`). **Not saved**: the server is off at each launch. Shows `Listening on {url}` while running, or the start error (e.g. port in use) |
| **Port** (number field) | 9339 | MCP server port, 1–65535, saved. Applied on Enter or when the field loses focus: an invalid value is dropped, and a running server is restarted on the new port (`McpSettings` component) |

Settings are held in `page.tsx` through the `useAppConfig` hook, and saved to `app_config.json` in `BaseDirectory.AppConfig` on every change. The log file settings (`logFileEnabled`, `logFileFolder` — empty for the default folder —, `logFileRotation`, `logFileMaxFiles`, `logFileMaxLines`) and the timestamp settings are also sent to the backend with `set_log_file_settings` at launch and whenever one of them changes. On mount, the file is read and merged over the defaults (`DEFAULT_APP_CONFIG`), so settings added later get their default value; a missing file keeps the defaults. `updateConfig` is stable and `ControlPanel` is memoized, so the settings panel does not render again with every new log line, only when a setting changes.

### Tab behavior
- **Inactive tabs stay mounted**: they are only hidden, so switching tabs keeps their internal state (open serial connection, loaded highlight rules).
- Inactive panels, of the main tabs and of the source tabs, use `display: none`.

---

## File Follow (tail -f)

Follows a file as it grows, like `tail -f`. Started from the [File tab](#file-tab).

- **Start**: the whole file is read, processed through the highlight rules and **replaces** the main and focus logs (`serial-datas` / `serial-datas-focus`). The log store source becomes `file_watch`.
- **Polling**: every **200 ms**, the file size is compared with the number of bytes already read:
  - grown → the new bytes are read, processed and **appended** (`serial-datas-append` / `serial-datas-focus-append`);
  - shrunk (truncation or rotation) → reading restarts from the beginning of the file, and the text waiting for a line terminator is dropped. The lines already displayed are kept;
  - missing → following stops.
- **Complete lines only**: a line is emitted only once terminated by `\n` (a trailing `\r` is stripped). The text after the last `\n` waits until a later read completes it. As a result, a line written in several steps is never split, appending `\nnew` to a file without a trailing newline adds no empty line, and the last line of a file without a trailing newline is not displayed.
- **Encoding**: the file is decoded as UTF-8. A character cut between two reads is completed on the next one; invalid bytes are replaced with `U+FFFD`.
- **Stop**: on user request or missing file, the loop exits, emits `file-watch-stopped` and resets the log store source to `file` if it still points to the followed file.

Line splitting and decoding live in `tail_splitter.rs` (`TailSplitter`, `decode_utf8`); `TailSplitter::finish` returns the unterminated last line for `open_file`.

---

## Highlight Settings Component

A table-based UI to define highlight/filter rules, persisted to `highlight_settings.json` in the app config directory.

The Highlight tab panel has a 12px padding on the sides and 16px at the top (24px at the bottom), narrower than the other panels (24px) so the table gets more room.

### Table structure

Each row represents one rule. Columns (left to right):

| Column | Width | Description |
|---|---|---|
| Drag handle | 28px | `DragIndicatorIcon`, draggable for reordering |
| Search | min 180px | Text input for the pattern, in a cell with no left padding to stay close to the drag handle and an 8px right padding before the color (the header label gets a 4px left padding so it lines up with the typed text, and a 2px bottom padding with a line height of 1 so it sits on the same line as the rotated option labels), with a tighter padding than the MUI small size (4px top, 1px bottom, 4px left, 8px right) to keep the rows short; the smaller bottom padding makes text without descenders look centered. Turns red (MUI `error` state) when `Regexp` is checked and the pattern is not a valid regex |
| Color | 32px | `ColorPickerButton`: a swatch opening a Sketch color picker with preset colors |
| Case sens. | 32px | Checkbox — match with case sensitivity (default: checked) |
| Regexp | 32px | Checkbox — treat search text as regex |
| Focus | 32px | Checkbox — send matching lines to focus panel |
| Remove | 32px | Checkbox — remove matched text from output |
| Whole line | 32px | Checkbox — apply highlight/removal to entire line |
| Advanced | 32px | Checkbox — enable per-capture-group coloring (requires Regexp) |
| Delete | 36px | `DeleteIcon` button |

The option checkboxes have a 6px padding (instead of the 9px of the MUI small size) to fit in their 32px columns.

Column headers are rotated **-45°** from the bottom-left corner with `overflow: visible`, in a 72px high header row. The header row is sticky: the table fills the panel height and scrolls by itself, so the column labels and the Load / Save buttons (drawn above the header) stay visible when scrolling through many rules. The table has a horizontal scrollbar when the panel is too narrow.

### Tooltips
Every option cell has a MUI `Tooltip` (placement `top`, with arrow). Each tooltip begins with the option name in uppercase followed by a colon:
- **COLOR**: *"Highlight color applied to matching text"*
- **CASE SENS.**: *"Match text with case sensitivity"*
- **REGEXP**: *"Treat the search as a regular expression"*
- **FOCUS**: *"Display the whole line in the focus panel"*
- **REMOVE**: *"Remove the text instead of highlighting it"*
- **WHOLE LINE**: *"Highlight or remove the entire line instead of just the matched text"*
- **ADVANCED**: *"Enable advanced mode to colorize individual regex capture groups with different colors (requires regex)"*
- **Delete**: *"Delete this rule"*

### Drag-and-drop reordering
- Each row has a drag handle (left column)
- Dragging shows a 2px colored insertion indicator (`primary.main`) above or below the target row
- Dropping reorders the array and saves

### Advanced mode (child row)
When a rule has both `is_regex = true` and `advanced = true`, a single child row appears below the parent row:

- The parent row's bottom border is hidden; the child row shows the bottom border
- The two rows are kept close: the Search cell of the parent row has a 2px bottom padding, and the child row no top padding
- The child row contains a horizontal list of **selections**, each consisting of:
  - A color picker (`ColorPickerButton`)
  - A text field (width 55px) for capture group numbers (e.g. `1,2`), with the same font and padding as the Search field
  - A delete button (hidden if only one selection remains)
- A single `+` button at the end of the row adds a new selection
- The child row starts with a `SubdirectoryArrowRightIcon` (grayed, `text.disabled`) and a left padding of 32px
- The text field has a tooltip explaining capture groups:
  > *"Enter the numbers of the capture groups from your regular expression that you want to colorize, separated by commas (e.g. 1,2). In a regex, parentheses define groups numbered left to right starting at 1. For example, with the regex `(\w+): (\d+)`, group 1 matches the word before the colon and group 2 matches the number after it."*

When `advanced = true`, the color picker on the parent row is displayed with `opacity: 0.2` (strongly grayed).
When `advanced = true`, the "Whole line" checkbox is disabled.
When `is_regex = false`, the "Advanced" checkbox is disabled.

### Save / Load buttons
Above the table (top-left, overlapping the table header slightly), two icon buttons allow exporting and importing the full rules set:
- **Load** (`FolderOpenIcon`) — opens a file picker filtered to `.json`, reads and parses the file, replaces the current rules
- **Save** (`SaveIcon`) — opens a save dialog filtered to `.json`, writes the current rules as formatted JSON

These are independent from the auto-save to `AppConfig`.

### Persistence
On every change, highlights are:
1. Sent to the Rust backend via `invoke("set_highlights", { highlights: [...] })`
2. Saved to `highlight_settings.json` in `BaseDirectory.AppConfig`
3. Applied to the lines already shown: once `set_highlights` has returned, the logs are refreshed (**Refresh**, `refresh_logs` command) after 300 ms without any other change, so typing a pattern does not reprocess the whole log on every key. Each change restarts the delay. The lines are read from the backend [log store](#log-store), so lines received meanwhile are neither lost nor shown twice, and lines evicted from the store (past its capacity) disappear

On mount, highlights are loaded from that file, without a refresh (there are no logs yet at launch).

A rule added by the MCP `add_highlight` tool (`mcp-add-highlight` event) is appended as a new row and goes through steps 1 and 2; the tool refreshes the logs itself.

### Rule data model (TypeScript)

```typescript
interface HighligtConfig {
  id: number;
  text: string;
  color: string;           // hex color e.g. "#cc7f12"
  is_regex: boolean;
  case_sensitive: boolean; // default true
  whole_line: boolean;
  advanced: boolean;
  advanced_selections: AdvancedSelection[];
  focus: boolean;
  remove: boolean;
}

interface AdvancedSelection {
  id: number;
  color: string;
  selector: string;        // comma-separated group numbers e.g. "1,2"
}
```

Default color for new rules: `#cc7f12`. New rules default to `is_regex: false`, `focus: true`, all others false.

---

## Backend (Rust)

### AppState

```rust
struct AppState {
    serial_connection: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    serial_writer: Arc<Mutex<Option<Box<dyn SerialPort>>>>, // clone of the open port, to send without waiting for the read loop
    highlights: Arc<Mutex<Arc<Vec<HighlightSettings>>>>, // replaced as a whole, so each line only clones the Arc
    message_id_counter: Arc<AtomicU64>,
    marker_counter: Arc<AtomicU64>,    // number of the last marker inserted
    log_files: Arc<std::sync::Mutex<LogFiles>>, // automatic save of the serial log, see Log Files
    file_watch_active: Arc<AtomicBool>,
    file_watch_session: Arc<AtomicU64>, // incremented by every Follow / Stop, stops replaced follow loops
    log_store: Arc<LogStore>,          // copy of every emitted line, served by MCP
    serial_connected: Arc<AtomicBool>, // lock-free mirror of serial_connection.is_some()
    serial_session: Arc<AtomicU64>,    // incremented by every open / close, stops stale reconnection loops
    mcp_server: Arc<Mutex<Option<McpServerHandle>>>,
    highlights_updated: Arc<Notify>,   // signaled by set_highlights, awaited by MCP add_highlight
    publish_lock: Arc<Mutex<()>>,      // held while the log store is changed and the change emitted
}
```

`publish_lock` is taken by every change of the log store together with its event (`publish_one`, `publish_append`, `publish_replace`, `insert_marker`, both `clear_logs`), so the window receives the changes in the order of the store. `refresh` relies on it to replace the log without losing the lines received meanwhile.

```rust
```

### Tauri Commands

#### `list_ports() -> Vec<SerialPortEntry>`
Returns available serial ports. For USB ports, the label is `manufacturer + product`; for others, a generic string. Returns `{ portName, deviceLabel }`.

#### `open_port(port_name, port_description?, baud_rate, auto_reconnect?)`
Opens the serial port and spawns a Tokio task that reads what has arrived, up to 4 KiB at a time (the blocking read runs in `block_in_place`, with a 200 ms timeout, which is also how long a Disconnect may wait), assembles lines (splitting on `\r\n`, `\n\r`, `\r`, or `\n`), and processes each line through `process_one`. Non-ASCII bytes are emitted as hex strings (e.g. `0xe9 `). Processed lines are emitted as `serial-data` events.

On success, starts a new [log file](#log-files) session, then emits a system message: `[HH:MM:SS] KazeSerial: Connection to {port} ({description}) established`.
On failure, emits a system message: `[HH:MM:SS] KazeSerial: Connection failed: {error}` and returns an error.
If the read loop encounters a non-timeout I/O error (device disconnected):
- **without `auto_reconnect`** (default): emits `[HH:MM:SS] KazeSerial: Connection to {port} lost` and `serial-disconnected`, and exits the loop;
- **with `auto_reconnect`**: releases the port, emits `Connection to {port} lost, waiting for it to come back` and `serial-reconnecting`, then tries to reopen the port with the same baud rate every 500 ms (`wait_for_port`). Once open, emits `Connection to {port} re-established` (or `… re-established as {new port}`) and `serial-reconnected` with the port name, and resumes reading; a partially received line is dropped. `serial_connected` (MCP `get_status`) is false while waiting.

A USB device reset while its port is still open often comes back under another name (`/dev/ttyACM0` → `/dev/ttyACM1`). So on Connect, the USB identity of the port (VID, PID, serial number) is recorded, and each attempt looks for it among the available ports (`find_reconnect_port`):

| Port | Port reopened |
|---|---|
| Not USB | The original name (it may not be listed, e.g. a pseudo terminal) |
| USB with a serial number | The port of the same device (same VID, PID and serial number), whatever its name; the original name first |
| USB without serial number | The original name if it is a port with the same VID/PID again, otherwise the only port with that VID/PID. With several such ports the device cannot be told apart, so none is opened and the wait goes on |

When the name changed, the log store source is updated and the Serial tab selects the new port.

Every `open_port` and `close_port` increments `serial_session`. A waiting loop stops silently when the session changes, i.e. on Disconnect or a new Connect, and checks it again under the connection lock before installing a reopened port.

`port_description` is optional — if omitted, the description part is empty.

Whenever the port is opened (Connect or auto-reconnect), a clone of it (`try_clone`) is kept in `serial_writer` to send to it: the read loop holds `serial_connection` across its blocking reads, so a send through it could wait up to 200 ms. Whenever the port is opened, lost or closed, `serial_writer` and `serial_connected` are updated and `serial-connection` is emitted (`set_serial_open`).

#### `close_port()`
Drops the serial port connection. Emits a system message: `[HH:MM:SS] KazeSerial: Connection closed`.

#### `send_serial(text, line_ending)`
Sends `text` followed by `line_ending` (`"none"`, `"lf"`, `"cr"` or `"crlf"`) to the serial port, for the [send bar](#send-bar). Without an open port, returns an error. Otherwise appends the sent line `>> {text}` to the log with `publish_one`, then writes the bytes through `serial_writer` (`write_all` then `flush`, in `spawn_blocking`). A failure is returned as an error and shown as the system message `Send failed: {error}`.

#### `set_highlights(highlights: Vec<HighlightMessage>)`
Compiles and stores highlight rules. Validates regexes (invalid rules are skipped). Converts the `advanced_selections` field into `AdvancedSelectionSetting` structs (parsing comma-separated group numbers).

#### `clear_logs()`
Clears the [log store](#log-store) and resets the marker numbering. Called when the user clears the main log (Clear button or Ctrl+Shift+R). Unlike the MCP `clear_logs` tool, it does not emit `logs-cleared`, so the focus panel is left as the user chose.

#### `watch_file(path)`
Stops any running file follow, reads the file, replaces the logs with its lines, then spawns the follow loop described in [File Follow](#file-follow-tail--f). Returns an error if the file cannot be read. Each Follow starts a new session (`file_watch_session`): a loop whose session was replaced exits at its next check, without emitting `file-watch-stopped`, so a single loop ever follows a file.

#### `stop_file_watch()`
Ends the follow session. The loop exits within 200 ms and emits `file-watch-stopped`.

#### `start_mcp_server(port?) -> McpStatus`
Starts the [MCP server](#mcp-server) on `127.0.0.1:port` (default `9339`; `0` lets the OS pick a free port). Does nothing if it is already running. Emits the system message `MCP server listening on {url}`.

#### `stop_mcp_server() -> McpStatus`
Stops the MCP server and its sessions. Emits the system message `MCP server stopped`.

#### `get_mcp_status() -> McpStatus`
Returns `{ running, url, port }`.

#### `add_marker()`
Appends a numbered marker line `----- MARK n -----` (`marker_counter`) as a `serial-data` event, with a reception timestamp, see [Markers](#markers).

#### `insert_marker(before_id, timestamp?) -> Payload`
Creates a numbered marker line with the given timestamp and inserts it in the log store just before the line `before_id` (nothing is recorded when that line is no longer in the store). Emits nothing: the marker is returned and the frontend inserts it in the main and focus lists, see [Markers](#markers).

#### `set_log_file_settings(settings: LogFileSettings)`
Applies the [log file](#log-files) settings, sent by the frontend at launch and on every change:

```rust
struct LogFileSettings {        // camelCase in JSON
    enabled: bool,
    folder: Option<String>,     // None or empty: default folder
    rotation: bool,
    max_files: usize,
    max_lines: usize,
    timestamps_in_text: bool,   // showTimestamps && timestampsInText
    timestamp_format: String,
    inactivity_ms: Option<u64>, // Some when timestampsAfterInactivityOnly
}
```

#### `get_default_log_folder() -> String`
Folder of the log files when none is chosen, shown in the Config tab.

#### `open_file(path)`
Reads the file once and replaces the logs with its lines (`serial-datas` / `serial-datas-focus`), without timestamps. The file is decoded as UTF-8 (invalid bytes replaced with `U+FFFD`) and split like a [followed file](#file-follow-tail--f) (`\n` separator, trailing `\r` stripped, empty lines kept); the last line is kept even without a trailing newline. Sets the log store source to `file`. Returns an error if the file cannot be read.

#### `add_logs_line(lines: Vec<String>)`
Used by Demo regenerate. Processes a batch of raw lines, without timestamps, through the highlight rules and emits:
- `serial-datas` — all processed lines
- `serial-datas-focus` — only lines that matched a focus rule

#### `refresh_logs()`
Used by the [automatic refresh](#persistence) of the Highlight tab; the MCP `add_highlight` tool calls the same `refresh` function. Re-applies the current highlight rules to every line of the [log store](#log-store), which holds the lines shown, and emits `serial-datas` / `serial-datas-focus`. Lines keep their id, timestamp and marker flag. The lines are processed in parallel without `publish_lock`, so lines keep being received; then, under the lock, the lines published meanwhile are processed too and the result replaces the log.

### Highlight processing pipeline (`process_line`)

Implemented by `process_line`, which is pure so batches can run in parallel.

**Raw text, one color per character.** Rules never see HTML. The line is kept as raw text with an optional color for each character, and rules are applied in order on that text:

| Rule | Effect |
|---|---|
| `remove` + `whole_line` | Clears the line, sets `removed_line = true` and **stops processing** |
| `remove` + regex + custom (`advanced`) | Removes the selected capture groups of each match (union of all selections); the whole match when none of them matched |
| `remove` (other) | Removes every match |
| `whole_line` | Colors every character of the line |
| regex + custom (`advanced`) | Colors each selected capture group with its selection color. Groups are sorted by (start, end); a group overlapping an already kept one is skipped. When no group matched, colors the whole match with the rule color |
| other | Colors every match |

- **Removal** deletes the characters with their colors. Later rules see the remaining text.
- **Priority**: a rule overrides the colors set by earlier rules on the characters it colors. Whole-line rules follow the same priority: a later rule wins.
- **Matching**: a rule applies when it matches the current text. Plain-text rules match their text literally (compiled as an escaped regex). Rules with an empty text are ignored.
- **Case**: `case_sensitive = false` compiles the rule case-insensitively, for regex and plain-text rules alike. The original casing is kept in the output.
- **Focus**: if a matching rule has `focus = true` and `remove = false`, the line is marked `matched = true`.

**HTML output.** Once all rules are applied, `message` is built with one `<span style="color:COLOR;">` per run of same-colored characters. The log text and the color value are HTML-escaped (`&`, `<`, `>`, `"`), so log content is always displayed as is and never interpreted as markup.

**`rawline`** is set to the original line whenever a rule matched or `message` differs from it (escaped characters). Refresh, Save and the log store read `rawline` when present and `message` otherwise, so they always get the raw text.

### Message payload (emitted to frontend)

```rust
struct Payload {
    id: u64,
    message: String,        // escaped HTML string with <span> tags
    matched: bool,
    rawline: Option<String>,
    removed_line: bool,
    timestamp: Option<u64>, // reception time in ms since the Unix epoch, None when unknown
    marker: bool,           // marker line, see Markers
    sent: bool,             // text sent to the serial port, see Send bar
}
```

### HighlightMessage (received from frontend)

```rust
struct HighlightMessage {
    text: String,
    color: String,
    is_regex: bool,
    case_sensitive: bool,   // default true
    select_mode: HighlightSelectMode,  // "match" | "whole_line" | "custom"
    advanced_selections: Vec<AdvancedSelectionMessage>, // groups and colors of the "custom" mode
    focus: bool,
    remove: bool,
}

struct AdvancedSelectionMessage {
    color: String,
    custom_select: String,   // comma-separated group numbers
}
```

### Payload conversion (frontend → backend)

When `advanced = true` and `is_regex = true`:
- `select_mode` is set to `"custom"`
- `advanced_selections` is populated with each selection's `{ color, custom_select: selector }`

The backend skips a rule without text, ignores the selections without any valid group, and treats a `"custom"` rule left without selection (or that is not a regex) as `"match"`: it colors the whole matches.

Otherwise:
- `select_mode` is `"whole_line"` if `whole_line = true`, else `"match"`
- `advanced_selections` is omitted

### System Messages

Certain backend events (connection and MCP server lifecycle) are surfaced as regular log lines in the main terminal, rendered in the same monospace font as serial data. They are processed through the current highlight rules like any other line, so they can be colored, sent to the focus panel or removed.

Format: `[HH:MM:SS] KazeSerial: {message}` where the time is the local time of the line's timestamp (`log_file::format_timestamp`).

| Trigger | Message |
|---|---|
| Port opened successfully | `Connection to {port} ({description}) established` |
| Port open failed | `Connection failed: {error}` |
| Read loop I/O error | `Connection to {port} lost` |
| Read loop I/O error, with auto-reconnect | `Connection to {port} lost, waiting for it to come back` |
| Port reopened by auto-reconnect | `Connection to {port} re-established`, or `Connection to {port} re-established as {new port}` when it came back under another name |
| Port closed by user | `Connection closed` |
| MCP server started | `MCP server listening on {url}` |
| MCP server stopped | `MCP server stopped` |
| Writing a [log file](#log-files) failed (once, until writing resumes) | `Log file error: {error}` |
| Sending to the serial port failed (or no port open) | `Send failed: {error}` |

Implemented via `emit_system_msg(app, msg)` which allocates a message ID from the shared counter, processes the line with `process_line`, records it in the log store and emits a `serial-data` event.

---

## Log Store

`LogStore` (`log_store.rs`) keeps a backend copy of the log, so the MCP server can serve the same lines the user sees. Every emit site also records into it:

| Frontend event | Store operation |
|---|---|
| `serial-data`, `serial-datas-append` | append |
| `serial-datas` | replace the whole buffer |
| Insert a marker above a line (`insert_marker` command) | insert before that line |
| Clear button / Ctrl+Shift+R (`clear_logs` command) | clear |
| MCP `clear_logs` tool (then `logs-cleared`) | clear |

- Each record holds the line `id`, its **raw text** (`rawline`, or `message` when absent, never HTML), its `focus` / `removed` flags, its timestamp and its marker and sent flags. Refresh reprocesses the lines from here.
- It is a ring buffer: past the capacity (default **500 000** lines, `KAZESERIAL_LOG_CAPACITY` to override), the oldest lines are evicted and counted as dropped.
- It tracks the current source: `none`, `serial`, `file` (opened once with `open_file`) or `file_watch` (followed).
- Records are in log order. Ids increase along the log, except for a marker inserted above a line, whose new id is larger than the ids around it; `wait_for_logs` and `wait_for_pattern` walk records in id order. While the records are in id order (no marker inserted since the last clear or replace), the records newer than an id are found by binary search, instead of scanning the whole log on every new line.
- Appends and insertions wake up waiting MCP calls, so `wait_for_logs` and `wait_for_pattern` block instead of polling.

---

## Log Files

Automatic save of the serial log to files (`log_file.rs`, `LogFiles` in `AppState`), set in the [Config tab](#config-tab). Written by the backend as lines are published, so nothing is lost when the webview is busy.

- **Lines written**: the lines published one by one with `publish_one`, which are the lines received from the serial port (non-ASCII bytes included, as their hex strings), the [system messages](#system-messages), the markers appended at the end of the log (Ctrl+M, toolbar button) and the [sent lines](#send-bar). Lines of an opened or followed file (already on disk), demo lines and markers [inserted above a line](#markers) (the file is never rewritten) are not written. Clearing the logs or Refresh does not change the files.
- **Sessions**: each successful `open_port` starts a session, so the next line opens a new file; an automatic reconnection continues the same file. Nothing is written before the first connection since launch (no file holding only e.g. `MCP server listening`). After a disconnection, lines (system messages, markers) still go to the last file.
- **Folder**: the chosen folder, or by default `KazeSerial/logs` in the user data folder (`app.path().data_dir()`: `~/.local/share/KazeSerial/logs` on Linux, `%APPDATA%\KazeSerial\logs` on Windows). The installation folder is not used, as it is usually read-only (`.deb`, `.msi`, AppImage). The folder is created when missing.
- **File names**: `kazeserial_YYYY-MM-DD_HH-mm-ss.log`, the local time the file is created, with a `_2`, `_3`... suffix when the name is taken (files created within the same second).
- **Line format**: as written by Save: the raw line (`rawline`, else `message`, without colors, lines removed by a rule included), followed by `\n`. Serial lines never contain a line break, see [`SerialSplitter`](#open_portport_name-port_description-baud_rate-auto_reconnect). With **Show timestamps** and **Include timestamps in copied and saved text**, it is prefixed with the timestamp column in the configured format, local time; with **Only after inactivity**, only on lines arriving at least the delay after the previous line of the file, blanks of the same width otherwise. Every line is flushed, so the file is complete if the application stops.
- **Rotation** (on): a file holds at most **Max lines per file** lines, then the next line opens a new file. After a file is created, only the **Max files** most recent `kazeserial_*.log` of the folder are kept, files of previous sessions and the new file included: the oldest (by modification time, then name) are deleted. Other files of the folder are never touched; a file that cannot be deleted is kept.
- **Rotation** (off): one file per session, without line limit, and no file is deleted.
- **Settings changes**: disabling the save or changing the folder closes the current file (the next line opens a new one in the folder); other changes apply to the current file.
- **Errors**: when creating or writing a file fails (folder not writable, disk full...), the system message `Log file error: {error}` is shown once, and nothing more is written until the next session or settings change, which retry with a new file. Lines published in the meantime are not written later.

---

## MCP Server

Embedded [MCP](https://modelcontextprotocol.io) server (`mcp.rs`, `rmcp` crate) giving an AI agent read access to the [log store](#log-store) while the user keeps using the window. User-facing setup is described in the README.

- **Transport**: Streamable HTTP at `http://127.0.0.1:{port}/mcp`, served inside the Tauri process. Bound to loopback only; the `Host` header is checked against loopback names against DNS rebinding.
- **Lifecycle**: off by default, and never started automatically from the settings. Started and stopped from the [Config tab](#config-tab) (**Enable MCP server**, on the saved **Port**), or at launch when `KAZESERIAL_MCP_PORT` is set (`0` picks a free port, printed in the log).
- **Scope**: read-only apart from `clear_logs` and `add_highlight`. Nothing can touch the serial port or the files.
- **Limits**: a call returns at most **20 000** lines; a wait blocks at most **120 s**.

### Tools

| Tool | Returns |
|---|---|
| `get_status` | Source, serial / file follow state, line and focus counts, oldest and newest ids, dropped lines, capacity. Meant as the first call: its ids are the cursors the other tools take |
| `tail_logs(count=100)` | The last lines, oldest first |
| `get_logs_range(from_id, to_id, max_lines=2000)` | Lines between two ids, inclusive |
| `get_all_logs(offset=0, max_lines=2000)` | The whole buffer, paginated with `next_offset` |
| `get_focus_logs(count=100)` | The last focus lines |
| `search_logs(pattern, is_regex=false, ignore_case=true, limit=100, context_before, context_after, from_id, to_id)` | Matching lines with optional context lines (at most 500 each side) |
| `wait_for_logs(after_id, timeout_ms=15000, max_lines=500)` | Blocks until lines with `id > after_id` arrive; returns them with the new `last_id` |
| `wait_for_pattern(after_id, pattern, is_regex=false, ignore_case=true, skip_occurrences=0, timeout_ms=15000)` | Blocks until a line with `id > after_id` matches, after skipping `skip_occurrences` matches; returns it with the new `last_id` |
| `clear_logs` | Clears the store, resets the marker numbering, and emits `logs-cleared` so the window is cleared too |
| `add_highlight(pattern, is_regex=false, case_sensitive=true, color="#cc7f12", focus=true, remove=false, whole_line=false, advanced_selections=[])` | Emits `mcp-add-highlight` and waits (10 s max) for the window's `set_highlights`, then refreshes the logs (`refresh`), so the lines already shown are processed when it returns; returns the rule and the line counts (`total_lines`, `focus_lines`). `advanced_selections` is a list of `{ groups: [1, 3], color? }`. Rejected: invalid regex or color, advanced without regex or with `whole_line`, unknown group |

Line ids are stable within a session and never reused. They give the order in which lines were added, which is the log order except for a [marker inserted above a line](#markers): `wait_for_logs` and `wait_for_pattern` walk lines in id order, so such a marker is reported once, as a new line, and `newest_id` is the largest id, not the id of the last line. The other tools return lines in log order.

---

## Tauri Events (backend → frontend)

| Event | Payload | Description |
|---|---|---|
| `serial-data` | `SerialMessage` | Single line from serial port read loop, or a system message |
| `serial-datas` | `SerialMessage[]` | Batch of reprocessed lines (replaces full log) |
| `serial-datas-focus` | `SerialMessage[]` | Batch of focus-matched lines (replaces full focus log) |
| `serial-datas-append` | `SerialMessage[]` | Batch of new lines to append to the log |
| `serial-datas-focus-append` | `SerialMessage[]` | Batch of new focus-matched lines to append |
| `file-watch-stopped` | *(empty)* | Emitted when the file follow loop exits (user stop or missing file). The frontend resets the Follow button. |
| `logs-cleared` | *(empty)* | Emitted when an MCP client calls `clear_logs`. The frontend clears the main and focus logs so the window stays in sync. |
| `mcp-add-highlight` | rule (`HighlightRule`, persisted rule shape) | Emitted by the MCP `add_highlight` tool. The Highlight tab appends the rule. |
| `serial-disconnected` | *(empty)* | Emitted when the read loop exits due to a hardware I/O error (device unplugged) without auto-reconnect. The frontend listens to this event to reset the Connect button to its disconnected state. |
| `serial-reconnecting` | *(empty)* | Emitted when the port is lost with auto-reconnect: the backend waits for it to come back. The Serial tab shows a waiting caption. |
| `serial-connection` | `boolean` | Emitted whenever the serial port is opened, lost or closed, with whether it is open now. The main page enables the [send bar](#send-bar) only while it is open. |
| `serial-reconnected` | `string` (port name) | Emitted when auto-reconnect reopened the port, possibly under another name. The Serial tab hides the waiting caption, selects that port and lists the ports again. |

---

## File Structure

```
app/
  page.tsx                  — Main page, layout, state management
  globals.css
  layout.tsx
  components/
    SerialTerminal.tsx       — Virtualized log viewer
    SerialTerminalLine.tsx   — Individual row renderer
    LogMinimap.tsx           — Minimap of the main terminal
    ControlPanel.tsx         — Tabbed source + settings panel
    SerialSettings.tsx       — Serial port configuration
    FileSettings.tsx         — File follow configuration (File tab)
    HighLighSettings.tsx     — Highlight/filter rules table
    ColorPickerButton.tsx    — Color swatch opening a Sketch picker (rules, new line highlight)
    SearchBar.tsx            — Search bar of the main terminal
    SendBar.tsx              — Send bar under the main terminal
    ConfigSettings.tsx       — Application settings (Config tab)
    McpSettings.tsx          — MCP server switch and port (Config tab)
  hooks/
    useAppConfig.ts          — Loads and saves the application settings
    useLogSearch.ts          — Search state and navigation (main terminal)
  types/
    SerialMessage.tsx        — SerialMessage type definition
    AppConfig.tsx            — Application settings type and defaults
  utils/
    timestamp.ts             — Timestamp formatting
    search.ts                — Search matching, per-line cache and highlight ranges
src-tauri/
  src/
    lib.rs                   — All Rust backend logic
    tail_splitter.rs         — Line splitting and UTF-8 decoding for file follow
    log_store.rs             — Backend copy of the log served by MCP
    log_file.rs              — Automatic save of the serial log to files, with rotation
    mcp.rs                   — Embedded MCP server and its tools
    main.rs                  — Tauri entry point
  tauri.conf.json
  Cargo.toml
```

---

## Key Design Decisions

- **HTML-in-messages**: The Rust backend sends each line as an HTML string with `<span style="color:...">` tags, rendered via `dangerouslySetInnerHTML`. The raw original line is stored in `rawline` to allow re-processing when rules change.
- **Rules on raw text, HTML built last**: rules used to inject tags into the line and run on that markup, and the log text was not escaped. A `<` in a log swallowed the rest of the line, HTML coming from a log or a device was interpreted by the webview (with access to Tauri commands), and rules could match inside tags (e.g. `\d` broke a `#cc7f12` color, `^` failed after a whole-line rule). Rules now only see the raw text and set per-character colors; the HTML is built once and escaped. Sending structured `{text, color}` segments instead of HTML was considered: it removes `dangerouslySetInnerHTML` entirely, but changes the event format and the frontend for little gain once the text is escaped.
- **Virtualized rendering**: `react-window` is used to handle tens of thousands of log lines without DOM performance issues. Every row has the same height, removed lines getting no row, so the list computes the rows in view directly instead of summing the heights of the rows above.
- **Highlight rule ordering**: Rules are applied sequentially; a later rule overrides earlier colors, and the first matching `remove=whole_line` rule terminates processing for that line.
- **Auto-scroll**: Each panel independently tracks whether auto-scroll is enabled. A timestamp-based ref suppresses false negatives when programmatically scrolling.
- **Persistence**: Highlight rules (`highlight_settings.json`) and application settings (`app_config.json`) are saved to JSON on every change and restored on startup. The frontend owns the canonical rule state and pushes it to the backend.
- **Resizable panels**: The vertical split (main/focus) is user-resizable via `re-resizable`. The horizontal split is achieved by making the terminals pane `flex: 1` and the settings pane a `re-resizable` component that resizes from its left edge. This avoids the issue where `re-resizable` injects `width` as an inline style, which would override any CSS flex behavior if the resizable element itself were the flex child.

---

## Batch Log Processing — Performance Design

Processing large batches (e.g. 10 000 lines) must complete in well under a second. Three design rules ensure this:

### 1. Single mutex acquisition per batch

The highlight rules are protected by a mutex. Rather than locking it once per line, `add_logs_line` and `append_logs_line` lock it **once** for the entire batch, clone the `Arc` holding the rules (the rules themselves are not copied), then release the lock before any processing begins. Lines received one by one (serial port, system messages) also only clone the `Arc`. This eliminates thousands of async suspend/resume cycles.

### 2. Parallel line processing with rayon

The core `process_line` function is **pure and synchronous** — no I/O, no locking. This makes it safe to run in parallel via `rayon`, which distributes the work across all available CPU cores automatically.

### 3. Bulk ID allocation

Rather than incrementing the message ID counter once per line (causing contention between parallel threads), the entire batch reserves a contiguous ID range in a **single atomic operation**. Each thread then computes its own ID by simple addition with no further synchronization.

### Append vs. replace

Two separate commands handle different use cases:

| Command | Frontend event | Frontend action |
|---|---|---|
| `add_logs_line`, `refresh_logs` | `serial-datas` / `serial-datas-focus` | **Replaces** the full log array (used by demo regenerate and Refresh) |
| `append_logs_line` | `serial-datas-append` / `serial-datas-focus-append` | **Appends** to the existing array (used by demo append and serial port) |

In `page.tsx`, appended lines (`serial-data` and `*-append` events) are applied once per frame (`createLineList`): copying the whole array for each line received would make a long capture quadratic and render the page for each line. Replacing or clearing a list drops the lines still waiting to be appended to it, so they cannot reappear after it.

This avoids resending thousands of existing lines to the backend just to append new ones.
