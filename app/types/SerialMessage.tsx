
export declare type SerialMessage = {
  id:number;
  message: string;
  matched: boolean;
  rawline?: string;
  removed_line?: boolean;
  timestamp?: number | null; // reception time in ms since the Unix epoch, null for a loaded file
};