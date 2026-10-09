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

---

## Layout

The main window (default 1600×1200, resizable) is divided horizontally into two panes.

### Terminals pane (left, fills all remaining width)
A vertical flex column containing:

1. **Main Serial Terminal** (top, default ~70% height, vertically resizable)
   - Displays all incoming log lines
   - Toolbar (top-right overlay, left to right):
     - **Auto-scroll toggle** (arrow-down icon) — enables/disables auto-scroll
     - **Refresh** (refresh icon) — reprocesses all raw lines through current highlight rules
     - **Open** (folder icon) — opens a file picker, loads a log file into the main terminal
     - **MCP** (robot icon) — starts or stops the [MCP server](#mcp-server). Highlighted in green (`rgba(76,175,80,0.28)`) while running; the tooltip then shows the server URL. The state is read with `get_mcp_status` on mount, since the server survives webview reloads
     - **Save** (save icon) — saves the main log to a `.log` file
     - **Delete** (delete icon) — clears the main log and the backend [log store](#log-store), so MCP clients see the same log. Ctrl+Shift+R also clears the focus log
     - **More** (three-dot icon, rightmost) — dropdown menu with demo utilities:
       - *Demo - Append 10k logs*
       - *Demo - Regenerate logs*

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
A **Control Panel** made of two tabbed areas: the **source tabs** at the top (data source selection) and the **settings tabs** below (highlight rules and configuration). See [Control Panel](#control-panel) for details. It is resizable from its **left edge** via `re-resizable` (default width ~30%, min 220px, max 70%) and can be collapsed to a thin strip.

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
- Each row is 20px tall; rows with `removed_line = true` have height 0 (invisible)
- Log text is rendered as HTML via `dangerouslySetInnerHTML` to support `<span style="color:...">` highlight markup. The backend escapes the log text, so only its own `<span>` tags are interpreted (see [Highlight processing pipeline](#highlight-processing-pipeline-parse_log_line))
- Font: monospace, 0.875rem, color `#d4d4d4`, background `#1e1e1e`
- Rows are as wide as their content (`width: max-content`, at least the terminal width), so the sticky line number gutter stays visible on long lines

### Line numbers
Enabled by the **Show line numbers** setting of the [Config tab](#config-tab). Like in a code editor, a gutter on the left of each row shows its line number.

- **Main terminal**: the position of the line in the main log, starting at 1. Lines hidden by a `remove` + `whole_line` rule are counted, so the numbering skips them and a number always designates the same line whatever the rules. It restarts at 1 when the log is cleared or replaced by a file load; Refresh keeps the same numbers.
- **Focus terminal**: the number of the same line in the main log, found by id (binary search, since ids increase along the log, with a linear search as fallback). Empty when that line is no longer in the main log.
- **Rendering**: the number is CSS generated content (`::before { content: attr(data-line-number) }`), so it is neither selectable nor part of copied text, and Save never includes it. The gutter is right-aligned, gray (`#545a62`), as wide as the largest number of the main log plus 2 characters, and `position: sticky` on the left with an opaque background so text scrolled horizontally passes under it. It follows the selected row highlight.
- The terminal receives it through an optional `lineNumbers` prop (`{ numberOf(index), digits }`); without it, no gutter is rendered.

### Auto-scroll
- When enabled, the list automatically scrolls to the last row when new logs arrive
- Scrolling up manually disables auto-scroll (detected when `scrollHeight - clientHeight - scrollTop > 30`)
- Scrolling back to the bottom re-enables it
- A debounce ref (`ignoreScrollUntilRef`) prevents false disables when programmatically scrolling

### Line selection / highlight
- Clicking a line highlights the entire row with `rgba(255,255,255,0.12)` background
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
};
```

---

## Control Panel

A panel on the right side split into two areas, each with its own row of full-width tabs (MUI `Tabs`).

### Source tabs (top)
Select the data source.

| Tab | Content |
|---|---|
| **Serial** (default) | Serial port configuration, see below |
| **File** | File follow (`tail -f`), see below |

#### Serial tab
Serial port configuration:
- **Port selector** — dropdown listing available ports with auto-detection on mount. Each entry shows `portName - deviceLabel` (manufacturer + product name for USB, or generic label). A refresh button re-lists ports.
- **Baud rate selector** — dropdown with values: 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600. Default: 115200.
- **Connect / Disconnect button** — on the same row as the baud rate selector. Calls `open_port` or `close_port` Tauri command. The button state (`isConnected`) is set to `true` only in the `.then()` callback of `open_port`, and to `false` in the `.then()` callback of `close_port` or upon receiving a `serial-disconnected` event. This ensures the button accurately reflects the actual connection state even when the port is lost unexpectedly.

#### File tab
`FileSettings` component, a single row:
- **Select button** (folder icon) — opens a file picker and shows the chosen path in the field. It does not start following.
- **File field** — read-only, shows the chosen path, truncated with an ellipsis; the full path is shown on hover.
- **Follow / Stop button** — calls `watch_file` with the chosen path, or `stop_file_watch`. The button state (`isFileWatching`) is set to `true` only in the `.then()` callback of `watch_file`, and to `false` on Stop or upon receiving a `file-watch-stopped` event.

While following, the select button and the file field are disabled. Follow is disabled until a file is chosen. See [File Follow](#file-follow-tail--f) for the backend behavior.

### Settings tabs (bottom, scrollable)
Occupy the remaining height of the panel. The content of the active tab scrolls vertically.

| Tab | Content |
|---|---|
| **Highlight** (default) | The `HighLighSettings` rules table, see [Highlight Settings Component](#highlight-settings-component) |
| **Config** | Application settings, see below |

#### Config tab
`ConfigSettings` component, a list of application settings:

| Setting | Default | Effect |
|---|---|---|
| **Show line numbers** (checkbox) | off | Shows a [line number gutter](#line-numbers) in the main and focus terminals |

Settings are held in `page.tsx` through the `useAppConfig` hook, and saved to `app_config.json` in `BaseDirectory.AppConfig` on every change. On mount, the file is read and merged over the defaults (`DEFAULT_APP_CONFIG`), so settings added later get their default value; a missing file keeps the defaults.

### Tab behavior
- **Inactive tabs stay mounted**: they are only hidden, so switching tabs keeps their internal state (open serial connection, loaded highlight rules).
- **Stable source area height**: the source tab panels are stacked in the same CSS grid cell, and only the active one is visible (`visibility: hidden` on the others). The source area always takes the height of its tallest tab, so the settings area does not move when switching source tabs, even to an empty one.
- **Settings tabs** use `display: none` for inactive panels, since the settings area fills the remaining height anyway.

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

Line splitting and decoding live in `tail_splitter.rs` (`TailSplitter`, `decode_utf8`).

---

## Highlight Settings Component

A table-based UI to define highlight/filter rules, persisted to `highlight_settings.json` in the app config directory.

### Table structure

Each row represents one rule. Columns (left to right):

| Column | Width | Description |
|---|---|---|
| Drag handle | 28px | `DragIndicatorIcon`, draggable for reordering |
| Search | min 180px | Text input for the pattern. Turns red (MUI `error` state) when `Regexp` is checked and the pattern is not a valid regex |
| Color | 36px | Native `<input type="color">` |
| Case sens. | 36px | Checkbox — match with case sensitivity (default: checked) |
| Regexp | 36px | Checkbox — treat search text as regex |
| Focus | 36px | Checkbox — send matching lines to focus panel |
| Remove | 36px | Checkbox — remove matched text from output |
| Whole line | 36px | Checkbox — apply highlight/removal to entire line |
| Advanced | 36px | Checkbox — enable per-capture-group coloring (requires Regexp) |
| Delete | 36px | `DeleteIcon` button |

Column headers are rotated **-45°** from the bottom-left corner with `overflow: visible`. The table has a horizontal scrollbar when the panel is too narrow.

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
- The child row contains a horizontal list of **selections**, each consisting of:
  - A color picker (`<input type="color">`)
  - A text field (width 55px) for capture group numbers (e.g. `1,2`)
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

On mount, highlights are loaded from that file.

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
    highlights: Arc<Mutex<Vec<HighlightSettings>>>,
    message_id_counter: Arc<AtomicU64>,
    file_watch_active: Arc<AtomicBool>,
    log_store: Arc<LogStore>,          // copy of every emitted line, served by MCP
    serial_connected: Arc<AtomicBool>, // lock-free mirror of serial_connection.is_some()
    mcp_server: Arc<Mutex<Option<McpServerHandle>>>,
}
```

### Tauri Commands

#### `list_ports() -> Vec<SerialPortEntry>`
Returns available serial ports. For USB ports, the label is `manufacturer + product`; for others, a generic string. Returns `{ portName, deviceLabel }`.

#### `open_port(port_name, port_description?, baud_rate)`
Opens the serial port and spawns a Tokio task that reads byte by byte, assembles lines (splitting on `\r\n`, `\n\r`, `\r`, or `\n`), and processes each line through `parse_log_line`. Non-ASCII bytes are emitted as hex strings (e.g. `0x1f `). Processed lines are emitted as `serial-data` events.

On success, emits a system message: `[HH:MM:SS] KazeSerial: Connection to {port} ({description}) established`.
On failure, emits a system message: `[HH:MM:SS] KazeSerial: Connection failed: {error}` and returns an error.
If the read loop encounters a non-timeout I/O error (device disconnected), emits: `[HH:MM:SS] KazeSerial: Connection to {port} lost` and exits the loop.

`port_description` is optional — if omitted, the description part is empty.

#### `close_port()`
Drops the serial port connection. Emits a system message: `[HH:MM:SS] KazeSerial: Connection closed`.

#### `set_highlights(highlights: Vec<HighlightMessage>)`
Compiles and stores highlight rules. Validates regexes (invalid rules are skipped). Converts the `advanced_selections` field into `AdvancedSelectionSetting` structs (parsing comma-separated group numbers).

#### `clear_logs()`
Clears the [log store](#log-store). Called when the user clears the main log (Clear button or Ctrl+Shift+R). Unlike the MCP `clear_logs` tool, it does not emit `logs-cleared`, so the focus panel is left as the user chose.

#### `watch_file(path)`
Stops any running file follow, reads the file, replaces the logs with its lines, then spawns the follow loop described in [File Follow](#file-follow-tail--f). Returns an error if the file cannot be read.

#### `stop_file_watch()`
Asks the follow loop to stop. It exits within 200 ms and emits `file-watch-stopped`.

#### `start_mcp_server(port?) -> McpStatus`
Starts the [MCP server](#mcp-server) on `127.0.0.1:port` (default `9339`; `0` lets the OS pick a free port). Does nothing if it is already running. Emits the system message `MCP server listening on {url}`.

#### `stop_mcp_server() -> McpStatus`
Stops the MCP server and its sessions. Emits the system message `MCP server stopped`.

#### `get_mcp_status() -> McpStatus`
Returns `{ running, url, port }`.

#### `add_logs_line(lines: Vec<String>)`
Processes a batch of raw lines through `parse_log_line` and emits:
- `serial-datas` — all processed lines
- `serial-datas-focus` — only lines that matched a focus rule

### Highlight processing pipeline (`parse_log_line`)

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
}
```

### HighlightMessage (received from frontend)

```rust
struct HighlightMessage {
    id: u64,
    text: String,
    color: String,
    is_regex: bool,
    case_sensitive: bool,   // default true
    select_mode: HighlightSelectMode,  // "match" | "whole_line" | "custom"
    custom_select: String,
    whole_line: bool,
    advanced_selections: Vec<AdvancedSelectionMessage>,
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
- If `advanced_selections` is empty, a single entry with the parent color and empty selector is used

Otherwise:
- `select_mode` is `"whole_line"` if `whole_line = true`, else `"match"`
- `advanced_selections` is omitted

### System Messages

Certain backend events (connection and MCP server lifecycle) are surfaced as regular log lines in the main terminal, rendered in the same monospace font as serial data. They are processed through the current highlight rules like any other line, so they can be colored, sent to the focus panel or removed.

Format: `[HH:MM:SS] KazeSerial: {message}` where the timestamp is UTC wall-clock time.

| Trigger | Message |
|---|---|
| Port opened successfully | `Connection to {port} ({description}) established` |
| Port open failed | `Connection failed: {error}` |
| Read loop I/O error | `Connection to {port} lost` |
| Port closed by user | `Connection closed` |
| MCP server started | `MCP server listening on {url}` |
| MCP server stopped | `MCP server stopped` |

Implemented via `emit_system_msg(app, msg)` which allocates a message ID from the shared counter, processes the line with `process_line`, records it in the log store and emits a `serial-data` event.

---

## Log Store

`LogStore` (`log_store.rs`) keeps a backend copy of the log, so the MCP server can serve the same lines the user sees. Every emit site also records into it:

| Frontend event | Store operation |
|---|---|
| `serial-data`, `serial-datas-append` | append |
| `serial-datas` | replace the whole buffer |
| Clear button / Ctrl+Shift+R (`clear_logs` command) | clear |
| MCP `clear_logs` tool (then `logs-cleared`) | clear |

- Each record holds the line `id`, its **raw text** (`rawline`, or `message` when absent, never HTML), and its `focus` / `removed` flags.
- It is a ring buffer: past the capacity (default **500 000** lines, `KAZESERIAL_LOG_CAPACITY` to override), the oldest lines are evicted and counted as dropped.
- It tracks the current source: `none`, `serial`, `file` (loaded once) or `file_watch` (followed).
- Appends wake up waiting MCP calls, so `wait_for_logs` and `wait_for_pattern` block instead of polling.

---

## MCP Server

Embedded [MCP](https://modelcontextprotocol.io) server (`mcp.rs`, `rmcp` crate) giving an AI agent read access to the [log store](#log-store) while the user keeps using the window. User-facing setup is described in the README.

- **Transport**: Streamable HTTP at `http://127.0.0.1:{port}/mcp`, served inside the Tauri process. Bound to loopback only; the `Host` header is checked against loopback names against DNS rebinding.
- **Lifecycle**: off by default. Started and stopped from the toolbar MCP button, or at launch when `KAZESERIAL_MCP_PORT` is set (`0` picks a free port, printed in the log).
- **Scope**: read-only apart from `clear_logs`. Nothing can touch the serial port or the files.
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
| `clear_logs` | Clears the store and emits `logs-cleared` so the window is cleared too |

Line ids are stable within a session and never reused.

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
| `serial-disconnected` | *(empty)* | Emitted when the read loop exits due to a hardware I/O error (device unplugged). The frontend listens to this event to reset the Connect button to its disconnected state. |

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
    ControlPanel.tsx         — Tabbed source + settings panel
    SerialSettings.tsx       — Serial port configuration
    FileSettings.tsx         — File follow configuration (File tab)
    HighLighSettings.tsx     — Highlight/filter rules table
    ConfigSettings.tsx       — Application settings (Config tab)
  hooks/
    useAppConfig.ts          — Loads and saves the application settings
  types/
    SerialMessage.tsx        — SerialMessage type definition
    AppConfig.tsx            — Application settings type and defaults
src-tauri/
  src/
    lib.rs                   — All Rust backend logic
    tail_splitter.rs         — Line splitting and UTF-8 decoding for file follow
    log_store.rs             — Backend copy of the log served by MCP
    mcp.rs                   — Embedded MCP server and its tools
    main.rs                  — Tauri entry point
  tauri.conf.json
  Cargo.toml
```

---

## Key Design Decisions

- **HTML-in-messages**: The Rust backend sends each line as an HTML string with `<span style="color:...">` tags, rendered via `dangerouslySetInnerHTML`. The raw original line is stored in `rawline` to allow re-processing when rules change.
- **Rules on raw text, HTML built last**: rules used to inject tags into the line and run on that markup, and the log text was not escaped. A `<` in a log swallowed the rest of the line, HTML coming from a log or a device was interpreted by the webview (with access to Tauri commands), and rules could match inside tags (e.g. `\d` broke a `#cc7f12` color, `^` failed after a whole-line rule). Rules now only see the raw text and set per-character colors; the HTML is built once and escaped. Sending structured `{text, color}` segments instead of HTML was considered: it removes `dangerouslySetInnerHTML` entirely, but changes the event format and the frontend for little gain once the text is escaped.
- **Virtualized rendering**: `react-window` is used to handle tens of thousands of log lines without DOM performance issues. Row heights are computed per-row (0 for removed lines).
- **Highlight rule ordering**: Rules are applied sequentially; a later rule overrides earlier colors, and the first matching `remove=whole_line` rule terminates processing for that line.
- **Auto-scroll**: Each panel independently tracks whether auto-scroll is enabled. A timestamp-based ref suppresses false negatives when programmatically scrolling.
- **Persistence**: Highlight rules (`highlight_settings.json`) and application settings (`app_config.json`) are saved to JSON on every change and restored on startup. The frontend owns the canonical rule state and pushes it to the backend.
- **Resizable panels**: The vertical split (main/focus) is user-resizable via `re-resizable`. The horizontal split is achieved by making the terminals pane `flex: 1` and the settings pane a `re-resizable` component that resizes from its left edge. This avoids the issue where `re-resizable` injects `width` as an inline style, which would override any CSS flex behavior if the resizable element itself were the flex child.

---

## Batch Log Processing — Performance Design

Processing large batches (e.g. 10 000 lines) must complete in well under a second. Three design rules ensure this:

### 1. Single mutex acquisition per batch

The highlight rules are protected by a mutex. Rather than locking it once per line, `add_logs_line` and `append_logs_line` lock it **once** for the entire batch, clone the rules, then release the lock before any processing begins. This eliminates thousands of async suspend/resume cycles.

### 2. Parallel line processing with rayon

The core `process_line` function is **pure and synchronous** — no I/O, no locking. This makes it safe to run in parallel via `rayon`, which distributes the work across all available CPU cores automatically.

### 3. Bulk ID allocation

Rather than incrementing the message ID counter once per line (causing contention between parallel threads), the entire batch reserves a contiguous ID range in a **single atomic operation**. Each thread then computes its own ID by simple addition with no further synchronization.

### Append vs. replace

Two separate commands handle different use cases:

| Command | Frontend event | Frontend action |
|---|---|---|
| `add_logs_line` | `serial-datas` / `serial-datas-focus` | **Replaces** the full log array (used by refresh) |
| `append_logs_line` | `serial-datas-append` / `serial-datas-focus-append` | **Appends** to the existing array (used by demo append and serial port) |

This avoids resending thousands of existing lines to the backend just to append new ones.
