// Application settings edited in the Config tab, persisted to AppConfig/app_config.json
export type AppConfig = {
  showLineNumbers: boolean;
  showTimestamps: boolean;
  // Timestamps are part of the line text: selectable, copied and saved
  timestampsInText: boolean;
  // Only show a timestamp on a line arriving after `timestampInactivityMs` without any line
  timestampsAfterInactivityOnly: boolean;
  timestampInactivityMs: number;
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  showLineNumbers: false,
  showTimestamps: false,
  timestampsInText: false,
  timestampsAfterInactivityOnly: false,
  timestampInactivityMs: 500,
};
