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
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  showLineNumbers: false,
  showTimestamps: false,
  timestampsInText: false,
  timestampsAfterInactivityOnly: false,
  timestampInactivityMs: 500,
  timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
  mcpPort: 9339,
};
