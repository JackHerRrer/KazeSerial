// Application settings edited in the Config tab, persisted to AppConfig/app_config.json
export type AppConfig = {
  showLineNumbers: boolean;
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  showLineNumbers: false,
};
