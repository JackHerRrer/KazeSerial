/** Timestamp formats offered in the Config tab; the first one is the default */
export const TIMESTAMP_FORMATS = ['HH:mm:ss.SSS', 'HH:mm:ss', 'YYYY-MM-DD HH:mm:ss.SSS'];
export const DEFAULT_TIMESTAMP_FORMAT = TIMESTAMP_FORMATS[0];

/** Codes replaced in a timestamp format, all fixed-width; any other character is kept as is */
const FORMAT_CODES = /YYYY|MM|DD|HH|mm|ss|SSS/g;

/**
 * Formats a reception time (ms since the Unix epoch) in local time with `format`, e.g.
 * `HH:mm:ss.SSS`. An empty format falls back to the default one.
 */
export const formatTimestamp = (timestamp: number, format: string = DEFAULT_TIMESTAMP_FORMAT): string => {
  const date = new Date(timestamp);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  const values: Record<string, string> = {
    YYYY: pad(date.getFullYear(), 4),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
    SSS: pad(date.getMilliseconds(), 3),
  };
  return (format.trim() === '' ? DEFAULT_TIMESTAMP_FORMAT : format).replace(FORMAT_CODES, code => values[code]);
};

/** Width of a timestamp formatted with `format`, in characters (codes are fixed-width) */
export const timestampWidth = (format: string): number => formatTimestamp(0, format).length;

/**
 * Text of the timestamp column when timestamps are part of the line text: the timestamp and a
 * separating space, or blanks of the same width so copied and saved lines stay aligned like on screen
 */
export const timestampColumnText = (timestamp: string, width: number): string =>
  timestamp ? `${timestamp} ` : ' '.repeat(width + 1);

/**
 * Whether the line at `index` shows its timestamp. With `inactivityMs`, only a line arriving at
 * least that long after the previous line of the same list shows it: a burst of lines gets a
 * single timestamp, each line restarting the delay.
 */
export const isTimestampShown = (
  lines: { timestamp?: number | null }[],
  index: number,
  inactivityMs?: number,
): boolean => {
  const timestamp = lines[index].timestamp;
  if (timestamp == null) return false;
  if (inactivityMs === undefined) return true;
  const previous = index > 0 ? lines[index - 1].timestamp : null;
  return previous == null || timestamp - previous >= inactivityMs;
};
