'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { writeTextFile, readTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { AppConfig, DEFAULT_APP_CONFIG } from '../types/AppConfig';

const CONFIG_FILE = 'app_config.json';

/** Application settings, loaded from and saved to AppConfig/app_config.json */
export function useAppConfig(): [AppConfig, (changes: Partial<AppConfig>) => void] {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);
  // Set by updateConfig, so the changes are saved but not the settings just loaded from the file
  const isChangedRef = useRef(false);

  useEffect(() => {
    readTextFile(CONFIG_FILE, { baseDir: BaseDirectory.AppConfig })
      // Defaults fill in settings added after the file was written
      .then(contents => setConfig({ ...DEFAULT_APP_CONFIG, ...JSON.parse(contents) }))
      // Missing on first launch: keep the defaults
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isChangedRef.current) return;
    isChangedRef.current = false;
    writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2), { baseDir: BaseDirectory.AppConfig })
      .catch((err: unknown) => console.error(err));
  }, [config]);

  // Stable, so the settings panel does not render again with every new log line
  const updateConfig = useCallback((changes: Partial<AppConfig>) => {
    isChangedRef.current = true;
    setConfig(previous => ({ ...previous, ...changes }));
  }, []);

  return [config, updateConfig];
}
