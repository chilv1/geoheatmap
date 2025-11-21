export interface CsvRow {
  gps_latitude: number;
  gps_longitude: number;
  carrier: string;
  [key: string]: any;
}

export interface ProcessingConfig {
  gridRes: number;
  radius: number;
  thresholdRatio: number;
}

export interface OperatorColorMap {
  [key: string]: string;
}

export const DEFAULT_COLORS: OperatorColorMap = {
  "ENTEL": "#0057A4",
  "MOVISTAR": "#00A65A",
  "CLARO": "#D40000",
  "BITEL": "#FFD500"
};

export const DEFAULT_CONFIG: ProcessingConfig = {
  gridRes: 2000,
  radius: 30,
  thresholdRatio: 0.3
};

export enum ProcessingState {
  IDLE = 'IDLE',
  PARSING = 'PARSING',
  GENERATING_LAYERS = 'GENERATING_LAYERS',
  ZIPPING = 'ZIPPING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}