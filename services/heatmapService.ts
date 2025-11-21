import { CsvRow, ProcessingConfig } from '../types';

// Helper to hex to rgb
const hexToRgb = (hex: string) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
};

interface Bounds {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

export const computeBounds = (data: CsvRow[]): Bounds => {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  
  for (const row of data) {
    if (row.gps_longitude < xmin) xmin = row.gps_longitude;
    if (row.gps_longitude > xmax) xmax = row.gps_longitude;
    if (row.gps_latitude < ymin) ymin = row.gps_latitude;
    if (row.gps_latitude > ymax) ymax = row.gps_latitude;
  }

  const dx = xmax - xmin;
  const dy = ymax - ymin;
  
  // Add 2% padding
  return {
    xmin: xmin - dx * 0.02,
    xmax: xmax + dx * 0.02,
    ymin: ymin - dy * 0.02,
    ymax: ymax + dy * 0.02
  };
};

// --- Scientific Processing Helpers ---

// Create 1D Gaussian Kernel
const createGaussianKernel = (sigma: number) => {
  // Kernel size approx 6*sigma for high precision, but strictly odd
  const size = Math.ceil(sigma * 3) * 2 + 1;
  const kernel = new Float32Array(size);
  const center = Math.floor(size / 2);
  let sum = 0;
  
  for (let i = 0; i < size; i++) {
    const x = i - center;
    const val = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernel[i] = val;
    sum += val;
  }
  
  // Normalize
  for (let i = 0; i < size; i++) {
    kernel[i] /= sum;
  }
  return kernel;
};

const convolveH = (data: Float32Array, width: number, height: number, kernel: Float32Array) => {
  const output = new Float32Array(data.length);
  const kSize = kernel.length;
  const kCenter = Math.floor(kSize / 2);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      // Optimized inner loop
      for (let k = 0; k < kSize; k++) {
        const kIdx = k - kCenter;
        // Clamp x
        const px = x + kIdx;
        const clampedX = px < 0 ? 0 : (px >= width ? width - 1 : px);
        sum += data[rowOffset + clampedX] * kernel[k];
      }
      output[rowOffset + x] = sum;
    }
  }
  return output;
};

const convolveV = (data: Float32Array, width: number, height: number, kernel: Float32Array) => {
  const output = new Float32Array(data.length);
  const kSize = kernel.length;
  const kCenter = Math.floor(kSize / 2);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let k = 0; k < kSize; k++) {
        const kIdx = k - kCenter;
        // Clamp y
        const py = y + kIdx;
        const clampedY = py < 0 ? 0 : (py >= height ? height - 1 : py);
        sum += data[clampedY * width + x] * kernel[k];
      }
      output[y * width + x] = sum;
    }
  }
  return output;
};

export const generateHeatmapLayer = async (
  data: CsvRow[],
  bounds: Bounds,
  color: string,
  config: ProcessingConfig
): Promise<Blob> => {
  const { gridRes, radius, thresholdRatio } = config;
  
  // 1. Initialize Grid (Histogram 2D)
  const grid = new Float32Array(gridRes * gridRes);
  const xScale = (gridRes - 1) / (bounds.xmax - bounds.xmin + 1e-9);
  const yScale = (gridRes - 1) / (bounds.ymax - bounds.ymin + 1e-9);

  // Accumulate density
  for (const row of data) {
    const xi = Math.round((row.gps_longitude - bounds.xmin) * xScale);
    const yi = Math.round((row.gps_latitude - bounds.ymin) * yScale);
    
    if (xi >= 0 && xi < gridRes && yi >= 0 && yi < gridRes) {
      grid[yi * gridRes + xi] += 1.0;
    }
  }

  // 2. Gaussian Blur (Separable Convolution)
  const kernel = createGaussianKernel(radius);
  const passH = convolveH(grid, gridRes, gridRes, kernel);
  const heat = convolveV(passH, gridRes, gridRes, kernel);

  // 3. Adaptive Thresholding (Percentile 99.5)
  const validValues: number[] = [];
  for (let i = 0; i < heat.length; i++) {
    if (heat[i] > 0) validValues.push(heat[i]);
  }
  
  let maxH = 0;
  if (validValues.length > 0) {
    validValues.sort((a, b) => a - b);
    const pIndex = Math.floor((validValues.length - 1) * 0.995);
    maxH = validValues[pIndex];
  } else {
    maxH = 0; 
  }

  const cutOff = maxH * thresholdRatio;
  const rgb = hexToRgb(color);

  // 4. Map to RGBA Image
  const canvas = document.createElement('canvas');
  canvas.width = gridRes;
  canvas.height = gridRes;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Canvas context failed");

  const imageData = ctx.createImageData(gridRes, gridRes);
  const pixels = imageData.data;

  for (let i = 0; i < heat.length; i++) {
    const val = heat[i];
    
    const y = Math.floor(i / gridRes);
    const x = i % gridRes;
    // Flip Y for display (Map coordinates vs Image coordinates)
    const targetY = gridRes - 1 - y; 
    const targetIdx = (targetY * gridRes + x) * 4;

    if (val < cutOff) {
      pixels[targetIdx + 3] = 0; // Transparent
    } else {
      // Normalize density value from cutoff to max
      let norm = (val - cutOff) / (maxH - cutOff);
      if (norm < 0) norm = 0;
      if (norm > 1) norm = 1;

      // Alpha mapping: 30% -> 100%
      const alpha = 77 + (255 - 77) * norm;
      
      // Lighting effect: Mix with white as density increases to create a "hot" look
      // norm = 0.0 -> Pure Operator Color
      // norm = 1.0 -> Operator Color mixed with 60% White
      const glow = norm * 0.6;

      const r = rgb.r + (255 - rgb.r) * glow;
      const g = rgb.g + (255 - rgb.g) * glow;
      const b = rgb.b + (255 - rgb.b) * glow;

      pixels[targetIdx] = Math.floor(r);
      pixels[targetIdx + 1] = Math.floor(g);
      pixels[targetIdx + 2] = Math.floor(b);
      pixels[targetIdx + 3] = Math.floor(alpha);
    }
  }

  ctx.putImageData(imageData, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Blob creation failed"));
    }, 'image/png');
  });
};