import React, { useState, useCallback, useRef, useEffect } from 'react';
import { DEFAULT_COLORS, DEFAULT_CONFIG, ProcessingState, ProcessingConfig, CsvRow } from './types';
import { parseCsv } from './services/csvService';
import { computeBounds, generateHeatmapLayer } from './services/heatmapService';
import { createKmz } from './services/kmzService';
import { Upload, FileText, CheckCircle, AlertCircle, Loader2, Download, Map as MapIcon, Eye, Trash2 } from 'lucide-react';

// Add Leaflet definition since we load via CDN
declare const L: any;

interface GeneratedLayer {
  name: string;
  blob: Blob;
  url: string; // For preview
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
}

const App: React.FC = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<ProcessingState>(ProcessingState.IDLE);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [logs, setLogs] = useState<string[]>([]);
  const [generatedLayers, setGeneratedLayers] = useState<GeneratedLayer[]>([]);
  const [kmzUrl, setKmzUrl] = useState<string | null>(null);
  const [config, setConfig] = useState<ProcessingConfig>(DEFAULT_CONFIG);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const layerGroupRef = useRef<any>(null);

  const addLog = (msg: string) => setLogs(prev => [...prev, msg]);

  // Initialize Map
  useEffect(() => {
    if (status === ProcessingState.COMPLETED && mapContainerRef.current && !mapRef.current) {
      // Init Leaflet
      const map = L.map(mapContainerRef.current).setView([0, 0], 2);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
      }).addTo(map);
      
      mapRef.current = map;
      layerGroupRef.current = L.layerGroup().addTo(map);
    }

    // Update Map Layers
    if (mapRef.current && layerGroupRef.current && generatedLayers.length > 0) {
      layerGroupRef.current.clearLayers();
      const bounds = generatedLayers[0].bounds;
      const southWest = L.latLng(bounds.south, bounds.west);
      const northEast = L.latLng(bounds.north, bounds.east);
      const mapBounds = L.latLngBounds(southWest, northEast);

      generatedLayers.forEach(layer => {
        const imageBounds = [[layer.bounds.south, layer.bounds.west], [layer.bounds.north, layer.bounds.east]];
        L.imageOverlay(layer.url, imageBounds, { opacity: 0.8 }).addTo(layerGroupRef.current);
      });

      mapRef.current.fitBounds(mapBounds);
    }
  }, [status, generatedLayers]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFiles = Array.from(e.target.files);
      
      if (selectedFiles.length > 5) {
        setErrorMsg("Maximum 5 files allowed.");
        setStatus(ProcessingState.ERROR);
        // Clear selection to allow retry
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      setFiles(selectedFiles);
      setStatus(ProcessingState.IDLE);
      setKmzUrl(null);
      setGeneratedLayers([]);
      setLogs([]);
      setErrorMsg('');
    }
  };

  const removeFile = (index: number) => {
    const newFiles = [...files];
    newFiles.splice(index, 1);
    setFiles(newFiles);
    
    // Reset processing state if we modify the input
    setStatus(ProcessingState.IDLE);
    setKmzUrl(null);
    setGeneratedLayers([]);
    setErrorMsg('');
    // If all files removed, logs can stay or clear. Let's clear errors.
  };

  const processFile = async () => {
    if (files.length === 0) return;

    try {
      setStatus(ProcessingState.PARSING);
      setLogs([]);
      setGeneratedLayers([]);
      setKmzUrl(null);
      
      addLog(`Starting processing for ${files.length} file(s)...`);
      
      let allData: CsvRow[] = [];

      // Parse all files
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        addLog(`[${i + 1}/${files.length}] Parsing ${file.name}...`);
        try {
            const data = await parseCsv(file);
            addLog(`   - Loaded ${data.length} rows.`);
            allData = allData.concat(data);
        } catch (err: any) {
            addLog(`   - Error parsing ${file.name}: ${err.message}`);
            throw new Error(`Failed to parse ${file.name}: ${err.message}`);
        }
      }

      if (allData.length === 0) {
        throw new Error("No valid data found in any of the uploaded files.");
      }

      addLog(`Total combined events: ${allData.length}`);

      setStatus(ProcessingState.GENERATING_LAYERS);
      const bounds = computeBounds(allData);
      addLog(`Calculated global bounds: N${bounds.ymax.toFixed(4)}, S${bounds.ymin.toFixed(4)}, E${bounds.xmax.toFixed(4)}, W${bounds.xmin.toFixed(4)}`);

      const carriers = Array.from(new Set(allData.map(d => d.carrier)));
      const layers: GeneratedLayer[] = [];

      for (const carrier of carriers) {
        const carrierData = allData.filter(d => d.carrier === carrier);
        addLog(`Processing layer: ${carrier} (${carrierData.length} points)...`);
        
        const color = DEFAULT_COLORS[carrier] || '#808080';
        
        // Yield to UI
        await new Promise(resolve => setTimeout(resolve, 20));

        const blob = await generateHeatmapLayer(carrierData, bounds, color, config);
        const url = URL.createObjectURL(blob);
        
        layers.push({
          name: carrier,
          blob,
          url,
          bounds: {
            north: bounds.ymax,
            south: bounds.ymin,
            east: bounds.xmax,
            west: bounds.xmin
          }
        });
      }

      setGeneratedLayers(layers);

      setStatus(ProcessingState.ZIPPING);
      addLog("Generating KMZ file...");
      
      // Convert GeneratedLayer back to service expected format
      const serviceLayers = layers.map(l => ({
          name: l.name,
          blob: l.blob,
          bounds: l.bounds
      }));
      
      const kmzBlob = await createKmz(serviceLayers);
      
      const kmzUrl = URL.createObjectURL(kmzBlob);
      setKmzUrl(kmzUrl);
      setStatus(ProcessingState.COMPLETED);
      addLog("Done! Preview updated.");

    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "An unknown error occurred");
      setStatus(ProcessingState.ERROR);
    }
  };

  const handleConfigChange = (key: keyof ProcessingConfig, value: number) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 font-sans">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <header className="mb-8 flex items-center gap-4">
          <div className="flex items-center justify-center w-14 h-14 bg-blue-600 rounded-xl shadow-lg shadow-blue-200">
            <MapIcon className="text-white w-7 h-7" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">GeoHeatmap Generator</h1>
            <p className="text-slate-500 text-sm">Visualize telecom density CSV data on Map & Export to KMZ</p>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Left Column: Inputs */}
          <div className="lg:col-span-1 space-y-6">
            {/* Configuration */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h2 className="text-sm font-bold uppercase text-slate-400 mb-4 tracking-wider">Settings</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Grid Resolution (px)</label>
                  <input 
                    type="number" 
                    value={config.gridRes} 
                    onChange={(e) => handleConfigChange('gridRes', parseInt(e.target.value))}
                    className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Blur Radius (sigma)</label>
                  <input 
                    type="number" 
                    value={config.radius} 
                    onChange={(e) => handleConfigChange('radius', parseInt(e.target.value))}
                    className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Threshold Ratio (0-1)</label>
                  <input 
                    type="number" 
                    step="0.05" 
                    value={config.thresholdRatio} 
                    onChange={(e) => handleConfigChange('thresholdRatio', parseFloat(e.target.value))}
                    className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                  />
                </div>
              </div>
            </div>

            {/* Upload & Process */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
               <h2 className="text-sm font-bold uppercase text-slate-400 mb-4 tracking-wider">Input Data</h2>
              
              {files.length === 0 ? (
                <div 
                  className="border-2 border-dashed border-slate-300 rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-slate-50 hover:border-blue-400 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="w-8 h-8 text-slate-400 mb-2" />
                  <p className="text-slate-700 font-medium text-sm">Upload CSV Files</p>
                  <p className="text-slate-400 text-xs mt-1">(Max 5 files)</p>
                  <input 
                    ref={fileInputRef}
                    type="file" 
                    accept=".csv" 
                    multiple
                    className="hidden" 
                    onChange={handleFileChange}
                  />
                </div>
              ) : (
                <div className="space-y-2 mb-4">
                  {files.map((file, index) => (
                    <div key={index} className="flex items-center justify-between bg-slate-50 p-3 rounded-lg border border-slate-200 animate-fade-in">
                      <div className="flex items-center gap-2 overflow-hidden">
                        <div className="p-1.5 bg-green-100 text-green-600 rounded flex-shrink-0">
                          <FileText className="w-4 h-4" />
                        </div>
                        <div className="truncate min-w-0">
                          <p className="font-medium text-slate-800 text-sm truncate">{file.name}</p>
                          <p className="text-[10px] text-slate-500">{(file.size / 1024).toFixed(1)} KB</p>
                        </div>
                      </div>
                      <button 
                        onClick={() => removeFile(index)}
                        className="text-slate-400 hover:text-red-500 transition-colors p-1"
                        title="Remove file"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  
                  {files.length < 5 && (
                    <button 
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full py-2 border border-dashed border-slate-300 text-slate-500 text-xs rounded-lg hover:bg-slate-50 hover:text-blue-600 transition-colors"
                    >
                        + Change Selection
                        <input 
                            ref={fileInputRef}
                            type="file" 
                            accept=".csv" 
                            multiple
                            className="hidden" 
                            onChange={handleFileChange}
                        />
                    </button>
                  )}
                </div>
              )}

              <button
                onClick={processFile}
                disabled={files.length === 0 || status !== ProcessingState.IDLE}
                className={`w-full py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 font-bold text-white text-sm transition-all mt-4
                  ${files.length === 0 || status !== ProcessingState.IDLE 
                    ? 'bg-slate-300 cursor-not-allowed' 
                    : 'bg-blue-600 hover:bg-blue-700 shadow-md shadow-blue-200 active:scale-[0.98]'
                  }`}
              >
                {status !== ProcessingState.IDLE && status !== ProcessingState.COMPLETED && status !== ProcessingState.ERROR ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>Run Generation</>
                )}
              </button>
            </div>

            {/* Logs */}
            <div className="bg-slate-900 rounded-xl p-4 font-mono text-[10px] text-slate-300 h-48 overflow-y-auto shadow-inner">
                {logs.length === 0 && <span className="text-slate-600 italic">Ready...</span>}
                {logs.map((log, i) => (
                <div key={i} className="border-l border-slate-700 pl-2 mb-1 last:mb-0 break-words">
                    {log}
                </div>
                ))}
            </div>
          </div>

          {/* Right Column: Preview & Result */}
          <div className="lg:col-span-2 flex flex-col gap-6">
            
            {/* Map Preview */}
            <div className="flex-1 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col min-h-[500px]">
              <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                <h3 className="font-semibold text-slate-700 flex items-center gap-2">
                  <Eye className="w-4 h-4" /> Map Preview
                </h3>
                {status === ProcessingState.COMPLETED && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                        {generatedLayers.length} Layers
                    </span>
                )}
              </div>
              
              <div className="relative flex-1 bg-slate-100">
                <div ref={mapContainerRef} className="absolute inset-0 z-0" />
                {status === ProcessingState.IDLE && generatedLayers.length === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center z-[1000] bg-slate-50/80 backdrop-blur-sm">
                        <p className="text-slate-400 text-sm">Upload data to see preview</p>
                    </div>
                )}
              </div>
            </div>

            {/* Action Bar */}
            {status === ProcessingState.COMPLETED && (
              <div className="bg-green-50 border border-green-100 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4 animate-fade-in">
                <div className="flex items-center gap-3">
                    <CheckCircle className="w-8 h-8 text-green-600" />
                    <div>
                        <h3 className="text-sm font-bold text-green-800">Processing Complete</h3>
                        <p className="text-xs text-green-700">KMZ file is ready for Google Earth.</p>
                    </div>
                </div>
                {kmzUrl && (
                    <a 
                    href={kmzUrl} 
                    download="operators_heatmap.kmz"
                    className="w-full sm:w-auto flex items-center justify-center gap-2 bg-green-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-green-700 transition-colors shadow-sm text-sm"
                    >
                        <Download className="w-4 h-4" />
                        Download KMZ
                    </a>
                )}
              </div>
            )}

             {status === ProcessingState.ERROR && (
                <div className="bg-red-50 border border-red-100 rounded-xl p-4 flex items-center gap-3 text-red-800">
                    <AlertCircle className="w-6 h-6" />
                    <div>
                        <p className="font-bold text-sm">Error</p>
                        <p className="text-xs">{errorMsg}</p>
                    </div>
                </div>
             )}

          </div>
        </div>
      </div>
    </div>
  );
};

export default App;