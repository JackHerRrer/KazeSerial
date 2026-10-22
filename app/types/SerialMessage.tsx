
export declare type SerialMessage = {
  id:number;
  message: string;
  matched: boolean;
  rawline?: string;
  removed_line?: boolean;
  timestamp?: number | null; // reception time in ms since the Unix epoch, null for a loaded file
  arrivedAt?: number; // frontend time the line was appended to the view, for the new line highlight
  marker?: boolean; // marker line inserted by the user (Ctrl+M), shown in a distinct style
  sent?: boolean; // text sent to the serial port by the user (`>> text`), shown in a distinct style
};