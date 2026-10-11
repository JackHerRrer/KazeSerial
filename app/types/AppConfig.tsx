// Application settings edited in the Config tab, persisted to AppConfig/app_config.json
export type AppConfig = {
  showLineNumbers: boolean;
  showTimestamps: boolean;
  // Timestamps are part of the line text: selectable, copied and saved
  timestampsInText: boolean;
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  showLineNumbers: false,
  showTimestamps: false,
  timestampsInText: false,
};
