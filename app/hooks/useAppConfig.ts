'use client';

import { useEffect, useState } from 'react';
import { writeTextFile, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { AppConfig, DEFAULT_APP_CONFIG } from '../types/AppConfig';

const CONFIG_FILE = 'app_config.json';

/** Application settings, loaded from and saved to AppConfig/app_config.json */
export function useAppConfig(): [AppConfig, (changes: Partial<AppConfig>) => void] {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);

  useEffect(() => {
    readTextFile(CONFIG_FILE, { baseDir: BaseDirectory.AppConfig })
      // Defaults fill in settings added after the file was written
      .then(contents => setConfig({ ...DEFAULT_APP_CONFIG, ...JSON.parse(contents) }))
      // Missing on first launch: keep the defaults
      .catch(() => undefined);
  }, []);

  const updateConfig = (changes: Partial<AppConfig>) => {
    const next = { ...config, ...changes };
    setConfig(next);
    writeTextFile(CONFIG_FILE, JSON.stringify(next, null, 2), { baseDir: BaseDirectory.AppConfig })
      .catch((err: unknown) => console.error(err));
  };

  return [config, updateConfig];
}
