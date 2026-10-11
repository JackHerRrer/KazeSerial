/** Formats a reception time (ms since the Unix epoch) as local HH:MM:SS.mmm */
export const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

/** Width of a formatted timestamp, in characters */
export const TIMESTAMP_WIDTH = 'HH:MM:SS.mmm'.length;
