import { DEFAULT_TIMESTAMP_FORMAT } from '../utils/timestamp';

// Application settings edited in the Config tab, persisted to AppConfig/app_config.json
export type AppConfig = {
  showLineNumbers: boolean;
  showTimestamps: boolean;
  // Timestamps are part of the line text: selectable, copied and saved
  timestampsInText: boolean;
  // Only show a timestamp on a line arriving after `timestampInactivityMs` without any line
  timestampsAfterInactivityOnly: boolean;
  timestampInactivityMs: number;
  // Format of the timestamp column, see formatTimestamp
  timestampFormat: string;
  // Port of the MCP server; the server itself is never started automatically
  mcpPort: number;
  // New lines get a background highlight fading out over `newLineHighlightMs`
  highlightNewLines: boolean;
  newLineHighlightMs: number;
  newLineHighlightColor: string; // #rrggbbaa, the alpha sets how visible it is
  // When the serial port is lost, wait for it to come back and reopen it (applied on Connect)
  autoReconnect: boolean;
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  showLineNumbers: false,
  showTimestamps: true,
  timestampsInText: false,
  timestampsAfterInactivityOnly: true,
  timestampInactivityMs: 500,
  timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
  mcpPort: 9339,
  highlightNewLines: true,
  newLineHighlightMs: 3000,
  newLineHighlightColor: '#7896b429',
  autoReconnect: true,
};
