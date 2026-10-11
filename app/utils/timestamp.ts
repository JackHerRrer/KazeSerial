/** Formats a reception time (ms since the Unix epoch) as local HH:MM:SS.mmm */
export const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

/** Width of a formatted timestamp, in characters */
export const TIMESTAMP_WIDTH = 'HH:MM:SS.mmm'.length;

/**
 * Text of the timestamp column when timestamps are part of the line text: the timestamp and a
 * separating space, or blanks of the same width so copied and saved lines stay aligned like on screen
 */
export const timestampColumnText = (timestamp: string): string =>
  timestamp ? `${timestamp} ` : ' '.repeat(TIMESTAMP_WIDTH + 1);

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
