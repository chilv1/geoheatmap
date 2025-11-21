import Papa from 'papaparse';
import { CsvRow } from '../types';

export const parseCsv = (file: File): Promise<CsvRow[]> => {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true, // Automatically converts numbers
      complete: (results) => {
        if (results.errors.length > 0) {
          console.warn("CSV Parse Warnings:", results.errors);
        }
        
        // Filter and validate data
        const cleanData: CsvRow[] = results.data
          .map((row: any) => ({
            gps_latitude: parseFloat(row.gps_latitude),
            gps_longitude: parseFloat(row.gps_longitude),
            carrier: row.carrier ? String(row.carrier).toUpperCase().trim() : ''
          }))
          .filter((row) => 
            !isNaN(row.gps_latitude) && 
            !isNaN(row.gps_longitude) && 
            row.carrier.length > 0
          );

        if (cleanData.length === 0) {
          reject(new Error("No valid rows found. Ensure columns: gps_latitude, gps_longitude, carrier exist."));
          return;
        }
        
        resolve(cleanData);
      },
      error: (error) => {
        reject(error);
      }
    });
  });
};