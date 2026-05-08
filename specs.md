# KazeSerial — Application Specifications

## Overview

KazeSerial is a desktop serial terminal application built with **Tauri v2** (Rust backend) and **Next.js / React** (frontend), using **Material UI (MUI)** as the component library. It allows users to monitor serial port output, apply color highlight/filter rules, and export logs.

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
   - Has an auto-scroll toggle button (arrow-down icon, top-right overlay)
   - Has a clear button (delete icon, top-right overlay)
   - Has a "refresh/reprocess" button (refresh icon, top-right overlay) that reprocesses all raw lines through current highlight rules

2. **"focus" label** — small monospace label with top border, always visible even when the focus panel is collapsed

3. **Focus Serial Terminal** (bottom, fills remaining height, collapsible)
   - Displays only lines that matched a highlight rule with `focus = true`
   - Has an auto-scroll toggle button
   - Has a clear button

#### Focus panel collapse button
A circular toggle button (36×36px, MUI `IconButton`) straddles the top border of the focus section (centered horizontally, `position: absolute`, `top: -18px`). It uses:
- `LastPage` icon rotated 90° when the focus panel is open (points downward = "collapse")
- `FirstPage` icon rotated 90° when the focus panel is closed (points upward = "expand")

When the focus panel is closed, the Main Terminal wrapper takes `flex: 1` to fill all available space above the "focus" label. When open, the wrapper uses `display: contents` so it is transparent to the flex layout and the Resizable component behaves as a direct child of the Container.

### Settings pane (right, collapsible)
A **Control Panel** with three tabs (Serial, Demo, File). It is resizable from its **left edge** via `re-resizable` (default width ~30%, min 220px, max 70%) and can be collapsed to a thin strip.

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
- Log text is rendered as raw HTML via `dangerouslySetInnerHTML` to support `<span style="color:...">` highlight markup
- Font: monospace, 0.875rem, color `#d4d4d4`, background `#1e1e1e`

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

### Focus panel click behavior
- Clicking a line in the **focus panel** scrolls the **main panel** to the corresponding line (matched by `id`) using `align: "center", behavior: "smooth"`
- The corresponding line in the main panel is also highlighted

---

## Serial Message Type

```typescript
type SerialMessage = {
  id: number;           // unique monotonically increasing ID
  message: string;      // HTML string (may contain <span> tags)
  matched: boolean;     // true if matched a focus rule
  rawline?: string;     // original unprocessed line (present if a rule matched)
  removed_line?: boolean; // true if the whole line was removed
};
```

---

## Control Panel

A tabbed panel on the right side.

### Tab: Serial
Serial port configuration:
- **Port selector** — dropdown listing available ports with auto-detection on mount. Each entry shows `portName - deviceLabel` (manufacturer + product name for USB, or generic label). A refresh button re-lists ports.
- **Baud rate selector** — dropdown with values: 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600. Default: 115200.
- **Connect / Disconnect button** — on the same row as the baud rate selector. Calls `open_port` or `close_port` Tauri command. The button state (`isConnected`) is set to `true` only in the `.then()` callback of `open_port`, and to `false` in the `.then()` callback of `close_port` or upon receiving a `serial-disconnected` event. This ensures the button accurately reflects the actual connection state even when the port is lost unexpectedly.

### Tab: Demo
Buttons for development/testing:
- **Append 10 Logs** — generates and processes 10000 fake UART log lines
- **Regenerate Logs** — resets timer and generates 10 fake lines

Fake log format: `[timestamp] TYPE: message` where TYPE is one of ERROR/WARN/INFO/DEBUG.

### Tab: File
- **Save logs to file** — opens a save dialog (`.log` extension), writes raw lines
- **Save focus logs to file** — same for focus logs
- **Load log files** — opens a file picker, reads content and sends lines to backend via `add_logs_line`

---

## Highlight Settings Component

A table-based UI to define highlight/filter rules, persisted to `highlight_settings.json` in the app config directory.

### Table structure

Each row represents one rule. Columns (left to right):

| Column | Width | Description |
|---|---|---|
| Drag handle | 28px | `DragIndicatorIcon`, draggable for reordering |
| Sentence | min 180px | Text input for the pattern |
| Color | 36px | Native `<input type="color">` |
| Regexp | 36px | Checkbox — treat sentence as regex |
| Focus | 36px | Checkbox — send matching lines to focus panel |
| Remove | 36px | Checkbox — remove matched text from output |
| Whole line | 36px | Checkbox — apply highlight/removal to entire line |
| Advanced | 36px | Checkbox — enable per-capture-group coloring (requires Regexp) |
| Delete | 36px | `DeleteIcon` button |

Column headers are rotated **-45°** from the bottom-left corner with `overflow: visible`. The table has a horizontal scrollbar when the panel is too narrow.

### Tooltips
Every option cell has a MUI `Tooltip` (placement `top`, with arrow):
- **Color**: *"Highlight color applied to matching text"*
- **Regexp**: *"Treat the sentence as a regular expression (regex)"*
- **Focus**: *"Display the full matching line in the focus panel"*
- **Remove**: *"Remove only the matched text from the line, not the entire line"*
- **Whole line**: *"Apply the highlight or removal to the entire line instead of just the matched text"*
- **Advanced**: *"Enable advanced mode to colorize individual regex capture groups with different colors (requires regex)"*
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

#### `add_logs_line(lines: Vec<String>)`
Processes a batch of raw lines through `parse_log_line` and emits:
- `serial-datas` — all processed lines
- `serial-datas-focus` — only lines that matched a focus rule

### Highlight processing pipeline (`parse_log_line`)

Rules are applied in order. For each rule that matches:

1. **`remove = true` + `whole_line = true`**: clear the line, mark `removed_line = true`, stop processing.
2. **`remove = true` + regex + `advanced`**: remove text at positions of all capture groups from all advanced selections.
3. **`remove = true` + regex (no advanced)**: remove the matched substring (or specific groups if `custom_select` is set).
4. **`remove = true` + plain text**: replace matched text with empty string.
5. **`remove = false` + `whole_line = true`**: wrap entire line in `<span style="color:COLOR">`.
6. **`remove = false` + regex + `advanced`**: wrap each capture group in its own colored span. Groups are sorted by start position; overlapping groups are skipped (first wins). If no groups are configured, fallback to coloring the whole match.
7. **`remove = false` + regex (no advanced, custom groups)**: wrap specified capture groups in colored span; if no groups, color the whole match.
8. **`remove = false` + regex (simple)**: replace match with `<span style="color:COLOR">$0</span>`.
9. **`remove = false` + plain text**: replace text with `<span style="color:COLOR">text</span>`.

If `focus = true` and `remove = false`, the line is marked `matched = true`.

The `rawline` field is set to the original unprocessed string whenever any rule matched (so the "refresh" feature can reprocess).

### Message payload (emitted to frontend)

```rust
struct Payload {
    id: u64,
    message: String,        // HTML string with <span> tags
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

Certain backend events (connection lifecycle) are surfaced as regular log lines in the main terminal, rendered in the same monospace font as serial data. They are not processed through highlight rules and always have `matched: false` and `removed_line: false`.

Format: `[HH:MM:SS] KazeSerial: {message}` where the timestamp is UTC wall-clock time.

| Trigger | Message |
|---|---|
| Port opened successfully | `Connection to {port} ({description}) established` |
| Port open failed | `Connection failed: {error}` |
| Read loop I/O error | `Connection to {port} lost` |
| Port closed by user | `Connection closed` |

Implemented via `emit_system_msg(app, msg)` which allocates a message ID from the shared counter and emits a `serial-data` event.

---

## Tauri Events (backend → frontend)

| Event | Payload | Description |
|---|---|---|
| `serial-data` | `SerialMessage` | Single line from serial port read loop, or a system message |
| `serial-datas` | `SerialMessage[]` | Batch of reprocessed lines (replaces full log) |
| `serial-datas-focus` | `SerialMessage[]` | Batch of focus-matched lines (replaces full focus log) |
| `serial-datas-append` | `SerialMessage[]` | Batch of new lines to append to the log |
| `serial-datas-focus-append` | `SerialMessage[]` | Batch of new focus-matched lines to append |
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
    ControlPanel.tsx         — Tabbed right panel
    SerialSettings.tsx       — Serial port configuration
    HighLighSettings.tsx     — Highlight/filter rules table
    FileSettings.tsx         — File import/export
  types/
    SerialMessage.tsx        — SerialMessage type definition
src-tauri/
  src/
    lib.rs                   — All Rust backend logic
    main.rs                  — Tauri entry point
  tauri.conf.json
  Cargo.toml
```

---

## Key Design Decisions

- **HTML-in-messages**: The Rust backend injects `<span style="color:...">` tags directly into the message string. The frontend renders this via `dangerouslySetInnerHTML`. The raw original line is stored in `rawline` to allow re-processing when rules change.
- **Virtualized rendering**: `react-window` is used to handle tens of thousands of log lines without DOM performance issues. Row heights are computed per-row (0 for removed lines).
- **Highlight rule ordering**: Rules are applied sequentially; the first matching `remove=whole_line` rule terminates processing for that line.
- **Auto-scroll**: Each panel independently tracks whether auto-scroll is enabled. A timestamp-based ref suppresses false negatives when programmatically scrolling.
- **Persistence**: Highlight rules are saved to JSON on every change and restored on startup. The frontend owns the canonical rule state and pushes it to the backend.
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
