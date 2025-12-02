import React, { useState, useRef, useEffect } from 'react';
import { Search, Download, Layers, Image as ImageIcon, X, Palette, Scissors, RefreshCw, Info, ExternalLink, MousePointer2, Copy, Check } from 'lucide-react';
import JSZip from 'jszip';

// --- Types ---
interface Crop {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  dataUrl: string;
}

interface Color {
  r: number;
  g: number;
  b: number;
  hex: string;
}

// --- Helper: Color Extraction ---
const rgbToHex = (r: number, g: number, b: number) => '#' + [r, g, b].map(x => {
  const hex = x.toString(16);
  return hex.length === 1 ? '0' + hex : hex;
}).join('');

// Updated default to 10 colors
const extractPalette = (imgData: ImageData, colorCount: number = 10): Color[] => {
  const data = imgData.data;
  const pixelCount = imgData.width * imgData.height;
  const sampleStep = Math.max(1, Math.floor(pixelCount / 2000));
  const colors: {r:number, g:number, b:number}[] = [];

  for (let i = 0; i < data.length; i += 4 * sampleStep) {
    if (data[i + 3] > 128) { // Ignore transparentish
      colors.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
    }
  }

  // Sort by brightness for better variety
  colors.sort((a, b) => (a.r + a.g + a.b) - (b.r + b.g + b.b));

  const palette: Color[] = [];
  if (colors.length === 0) return palette;

  const bucketSize = Math.floor(colors.length / colorCount);
  for (let i = 0; i < colorCount; i++) {
    const start = i * bucketSize;
    const end = start + bucketSize;
    let r = 0, g = 0, b = 0, count = 0;
    for (let j = start; j < end && j < colors.length; j++) {
      r += colors[j].r;
      g += colors[j].g;
      b += colors[j].b;
      count++;
    }
    if (count > 0) {
      r = Math.floor(r / count);
      g = Math.floor(g / count);
      b = Math.floor(b / count);
      palette.push({ r, g, b, hex: rgbToHex(r, g, b) });
    }
  }
  return palette;
};

// --- Helper: ASE File Generation ---
// Constructs an Adobe Swatch Exchange binary file
const createASE = (palette: Color[]): Blob => {
  const blocks: number[][] = [];
  let totalLength = 12; // Header (4+2+2+4)

  palette.forEach(color => {
    const name = color.hex.toUpperCase();

    // Name Block: Length (uint16) + String (UTF-16BE) + Null Terminator (uint16 as 0x0000)
    // Note: ASE stores name length in *characters* including the null terminator.
    const nameLen = name.length + 1;
    const nameBytes: number[] = [];

    // Write Name Length
    nameBytes.push((nameLen >> 8) & 0xFF, nameLen & 0xFF);

    // Write Name Characters (UTF-16BE)
    for (let i = 0; i < name.length; i++) {
        nameBytes.push(0, name.charCodeAt(i));
    }
    // Write Null Terminator
    nameBytes.push(0, 0);

    const colorModel = [0x52, 0x47, 0x42, 0x20]; // 'RGB '

    // RGB Floats (0.0 - 1.0)
    const view = new DataView(new ArrayBuffer(12));
    view.setFloat32(0, color.r / 255, false); // Big Endian
    view.setFloat32(4, color.g / 255, false);
    view.setFloat32(8, color.b / 255, false);
    const rgbBytes = Array.from(new Uint8Array(view.buffer));

    const colorType = [0x00, 0x02]; // 0=Global, 1=Spot, 2=Normal

    // Block content combined
    const blockData = [
        ...nameBytes,
        ...colorModel,
        ...rgbBytes,
        ...colorType
    ];

    const blockLen = blockData.length;
    // Block Header: Type (0x0001 for Color) + Length (int32)
    const blockHeader = [
        0x00, 0x01,
        (blockLen >> 24) & 0xFF, (blockLen >> 16) & 0xFF, (blockLen >> 8) & 0xFF, blockLen & 0xFF
    ];

    const fullBlock = [...blockHeader, ...blockData];
    blocks.push(fullBlock);
    totalLength += fullBlock.length;
  });

  // Construct final buffer
  const buffer = new Uint8Array(totalLength);
  let offset = 0;

  // Header: ASEF + Ver 1.0 + Block Count
  const header = [
      0x41, 0x53, 0x45, 0x46, // ASEF
      0x00, 0x01, // Ver Major 1
      0x00, 0x00, // Ver Minor 0
      (blocks.length >> 24) & 0xFF, (blocks.length >> 16) & 0xFF, (blocks.length >> 8) & 0xFF, blocks.length & 0xFF // Count
  ];

  header.forEach(b => buffer[offset++] = b);
  blocks.forEach(block => {
      block.forEach(b => buffer[offset++] = b);
  });

  return new Blob([buffer], { type: 'application/octet-stream' });
};

// --- Helper: YouTube ID Extraction ---
const getVideoId = (url: string) => {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
};

// --- Helper: Native File Saver ---
const saveAs = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const App = () => {
  // --- State ---
  const [url, setUrl] = useState('');
  const [videoId, setVideoId] = useState<string | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [crops, setCrops] = useState<Crop[]>([]);
  const [palette, setPalette] = useState<Color[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [currentSelection, setCurrentSelection] = useState<{x: number, y: number, w: number, h: number} | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // --- Refs ---
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // --- Effects ---

  // Handle Paste Events
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      // Ignore if pasting into an input field or textarea (like the URL bar or crop labels)
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            e.preventDefault(); // Prevent default paste behavior

            const reader = new FileReader();
            reader.onload = (event) => {
              const dataUrl = event.target?.result as string;

              // Load image to get dimensions for the metadata display
              const img = new Image();
              img.onload = () => {
                 setCrops(prev => {
                    const newCrop: Crop = {
                      id: Date.now().toString() + Math.random().toString(),
                      x: 0, // No coordinates for pasted images
                      y: 0,
                      width: img.width,
                      height: img.height,
                      label: `Pasted Layer ${prev.length + 1}`,
                      dataUrl: dataUrl
                    };
                    return [...prev, newCrop];
                 });
              };
              img.src = dataUrl;
            };
            reader.readAsDataURL(blob);
          }
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, []);

  // --- Handlers ---

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const id = getVideoId(url);
    if (!id) {
      setError('Invalid YouTube URL. Please try again.');
      return;
    }
    setVideoId(id);
    setImgLoaded(false);
    setCrops([]);
    setPalette([]);
    setCurrentSelection(null);
  };

  const handleImageLoad = () => {
    setImgLoaded(true);
    // Analyze palette automatically on load
    if (imgRef.current && canvasRef.current) {
      const img = imgRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);

      try {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // Updated to extract 10 colors
        const extractedColors = extractPalette(imageData, 10);
        setPalette(extractedColors);
      } catch (e) {
        console.warn("CORS restriction preventing pixel reading. Palette extraction skipped.", e);
        setError("Warning: Browser security prevented automatic color analysis. Cropping will still work!");
      }
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!imgRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setDragStart({ x, y });
    setIsDragging(true);
    setCurrentSelection({ x, y, w: 0, h: 0 });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();

    // Constrain to image bounds
    const currentX = Math.min(Math.max(0, e.clientX - rect.left), rect.width);
    const currentY = Math.min(Math.max(0, e.clientY - rect.top), rect.height);

    const w = currentX - dragStart.x;
    const h = currentY - dragStart.y;

    setCurrentSelection({
      x: w > 0 ? dragStart.x : currentX,
      y: h > 0 ? dragStart.y : currentY,
      w: Math.abs(w),
      h: Math.abs(h),
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const saveCrop = () => {
    if (!currentSelection || !imgRef.current || !canvasRef.current) return;
    if (currentSelection.w < 10 || currentSelection.h < 10) return; // Ignore tiny clicks

    const img = imgRef.current;

    // Calculate scaling ratio between displayed image and natural image
    const scaleX = img.naturalWidth / img.width;
    const scaleY = img.naturalHeight / img.height;

    const realX = Math.floor(currentSelection.x * scaleX);
    const realY = Math.floor(currentSelection.y * scaleY);
    const realW = Math.floor(currentSelection.w * scaleX);
    const realH = Math.floor(currentSelection.h * scaleY);

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = realW;
    tempCanvas.height = realH;
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
    if (!tempCtx) return;

    try {
      tempCtx.drawImage(img, realX, realY, realW, realH, 0, 0, realW, realH);

      // Convert to blob and copy to clipboard
      tempCanvas.toBlob(async (blob) => {
        if (!blob) {
            setError("Failed to process image data.");
            return;
        }

        try {
            await navigator.clipboard.write([
                new ClipboardItem({ [blob.type]: blob })
            ]);
            // Clear selection on success to indicate completion
            setCurrentSelection(null);
        } catch (err) {
            console.error("Clipboard copy failed", err);
            setError("Clipboard access denied. Check your browser permissions.");
        }
      }, 'image/png');

    } catch (e) {
      console.error(e);
      setError("Cannot crop: Security restrictions prevented saving this area.");
    }
  };

  const downloadAll = async () => {

    setLoading(true);
    try {
      const zip = new JSZip();

      // Add info file
      zip.file("README.txt", `Thumbnail Reconstruction Kit\nVideo ID: ${videoId || 'Custom Paste'}\nGenerated: ${new Date().toLocaleString()}\n\nThis kit contains isolated components from the thumbnail to help you recreate the design in tools like Affinity Designer or Photoshop.`);

      // Add palette
      if (palette.length > 0) {
        // Text Format
        const paletteInfo = palette.map(c => `HEX: ${c.hex} | RGB: ${c.r}, ${c.g}, ${c.b}`).join('\n');
        zip.file("palette.txt", paletteInfo);

        // ASE Format
        const aseBlob = createASE(palette);
        zip.file("palette.ase", aseBlob);
      }

      // Add full thumbnail - Direct Fetch to ensure quality and presence
      if (imgRef.current && imgRef.current.src && videoId) {
         try {
             const response = await fetch(imgRef.current.src);
             const blob = await response.blob();
             // We know the source is a PNG via the wsrv proxy
             zip.file("original_thumbnail.png", blob);
         } catch(e) {
             console.warn("Could not fetch original for zip, falling back to canvas", e);
             // Fallback: Canvas snapshot
             if (imgRef.current) {
                const fullCanvas = document.createElement('canvas');
                fullCanvas.width = imgRef.current.naturalWidth;
                fullCanvas.height = imgRef.current.naturalHeight;
                const ctx = fullCanvas.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                   ctx.drawImage(imgRef.current, 0,0);
                   const fullBlob = await new Promise<Blob | null>(resolve => fullCanvas.toBlob(resolve, 'image/jpeg', 0.95));
                   if(fullBlob) zip.file("original_thumbnail.jpg", fullBlob);
                }
             }
         }
      }

      // Add crops
      if (crops.length > 0) {
          const cropsFolder = zip.folder("components");
          crops.forEach((crop) => {
            const base64Data = crop.dataUrl.replace(/^data:image\/(png|jpg);base64,/, "");
            cropsFolder?.file(`${crop.label.replace(/\s+/g, '_')}.png`, base64Data, { base64: true });
          });
      }

      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, `thumbnail-kit-${videoId || 'custom'}.zip`);
    } catch (e) {
      console.error(e);
      setError("Failed to create ZIP file. Try downloading components individually.");
    } finally {
      setLoading(false);
    }
  };

  const copyAndSearch = async (crop: Crop) => {
    try {
      const res = await fetch(crop.dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob })
      ]);
      setCopiedId(crop.id);
      setTimeout(() => setCopiedId(null), 2000);
      window.open('https://images.google.com/', '_blank');
    } catch (err) {
      console.warn("Clipboard write failed. Falling back to download.", err);
      fetch(crop.dataUrl)
        .then(res => res.blob())
        .then(blob => {
            saveAs(blob, `${crop.label}.png`);
            window.open('https://images.google.com/', '_blank');
        });
      setError("Clipboard access denied by browser. Downloaded image instead.");
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 font-sans selection:bg-rose-500 selection:text-white">
      <style>{`
        /* Custom scrollbar for component list */
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #171717; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #444; }
      `}</style>

      {/* Header */}
      <header className="border-b border-neutral-800 bg-neutral-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 md:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-0.5">
            <img className="w-15 h-15" src="/thumbnail-deconstruct/favicon.png"/>
            <h2 className="font-bold text-lg tracking-tight">Thumbnail<span className="text-rose-500">Deconstruct</span></h2>
          </div>
          <div className="text-xs font-medium text-neutral-500 hidden sm:flex items-center gap-2 bg-neutral-900 px-3 py-1.5 rounded-full border border-neutral-800">
             <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"/>
             Ready to analyze
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 md:gap-8">

        {/* Left Col: Canvas & Tools */}
        <div className="lg:col-span-8 flex flex-col gap-6">

          {/* Input Section */}
          <form onSubmit={handleUrlSubmit} className="bg-neutral-900 border border-neutral-800 p-1.5 rounded-xl flex shadow-lg transition-all focus-within:ring-2 focus-within:ring-rose-500/20 focus-within:border-rose-500/50">
            <input
              type="text"
              placeholder="Paste YouTube URL here (e.g., https://youtu.be/...)"
              className="flex-1 bg-transparent px-4 py-3 outline-none text-neutral-200 placeholder-neutral-500 text-sm md:text-base"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button
              type="submit"
              className="bg-rose-600 hover:bg-rose-500 text-white px-6 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 shadow-lg shadow-rose-900/20"
            >
              <Search className="w-4 h-4" />
              <span className="hidden sm:inline">Load</span>
            </button>
          </form>

          {error && (
            <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 px-4 py-3 rounded-lg text-sm flex items-start gap-2">
              <Info className="w-4 h-4 mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          {/* Editor Area */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden shadow-2xl relative min-h-[300px] md:min-h-[450px] flex items-center justify-center group">
            {!videoId ? (
              <div className="text-neutral-600 flex flex-col items-center gap-4 p-8 text-center">
                <div className="w-20 h-20 bg-neutral-800 rounded-2xl flex items-center justify-center mb-2">
                    <ImageIcon className="w-10 h-10 opacity-20" />
                </div>
                <div className="space-y-1">
                    <p className="text-neutral-400 font-medium">No Image Loaded</p>
                    <p className="text-sm">Enter a YouTube URL above to retrieve the high-res thumbnail.</p>
                </div>
              </div>
            ) : (
              <div className="relative w-full h-full bg-[url('https://grainy-gradients.vercel.app/noise.svg')] bg-neutral-950/50 flex items-center justify-center p-4 md:p-8">

                 {/* Instructions Overlay */}
                 <div className="absolute top-4 left-4 z-20 pointer-events-none">
                    <div className="bg-black/80 backdrop-blur-md text-xs px-3 py-1.5 rounded-full border border-white/10 text-neutral-300 flex items-center gap-2 shadow-xl">
                      <MousePointer2 className="w-3 h-3 text-rose-500" />
                      Drag to select • Click "CLIP" to copy
                    </div>
                 </div>

                 {/* Image Container with Selection */}
                 <div
                   ref={containerRef}
                   className="relative inline-block cursor-crosshair select-none shadow-2xl ring-1 ring-white/10"
                   onMouseDown={handleMouseDown}
                   onMouseMove={handleMouseMove}
                   onMouseUp={handleMouseUp}
                   onMouseLeave={handleMouseUp}
                 >
                   {/* Main Image - Using wsrv.nl Proxy to Guarantee CORS headers */}
                   <img
                      ref={imgRef}
                      src={`https://wsrv.nl/?url=${encodeURIComponent(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`)}&output=png`}
                      crossOrigin="anonymous"
                      alt="Thumbnail"
                      className={`max-w-full h-auto block select-none transition-opacity duration-500 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
                      onLoad={handleImageLoad}
                      onError={() => setError("Could not load high-res thumbnail. Video might be unavailable or lacks a max-res thumb.")}
                      draggable={false}
                   />

                   {/* Selection Box */}
                   {currentSelection && currentSelection.w > 0 && (
                     <div
                       className="absolute border-2 border-rose-500 bg-rose-500/10 z-10 shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]"
                       style={{
                         left: currentSelection.x,
                         top: currentSelection.y,
                         width: currentSelection.w,
                         height: currentSelection.h,
                       }}
                     >
                       {/* Floating Action for Selection */}
                       <div
                        className="absolute -bottom-10 right-0 bg-rose-600 text-white px-3 py-1.5 rounded-md text-xs font-bold cursor-pointer shadow-lg hover:bg-rose-500 flex items-center gap-1 active:scale-95 transition-transform"
                        onMouseDown={(e) => e.stopPropagation()} /* STOP PROPAGATION HERE */
                        onClick={(e) => { e.stopPropagation(); saveCrop(); }}
                       >
                         <Scissors className="w-3 h-3" />
                         COPY TO CLIPBOARD
                       </div>
                     </div>
                   )}
                 </div>
              </div>
            )}

            {/* Hidden canvas for processing */}
            <canvas ref={canvasRef} className="hidden" />
          </div>

          {/* Palette Section */}
          {videoId && imgLoaded && (
             <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                        <Palette className="w-5 h-5 text-rose-500" />
                        <h3 className="font-semibold text-neutral-200">Dominant Palette</h3>
                    </div>
                    <span className="text-xs text-neutral-500">Auto-extracted from image</span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                  {palette.length > 0 ? palette.map((color, idx) => (
                    <div key={idx} className="group relative flex items-center gap-3 bg-neutral-950 p-2 rounded-lg border border-neutral-800 hover:border-neutral-700 transition-colors">
                      <div
                        className="w-8 h-8 rounded-md shadow-sm ring-1 ring-white/10 shrink-0"
                        style={{ backgroundColor: color.hex }}
                      />
                      <div className="flex flex-col min-w-0">
                          <span className="text-[10px] text-neutral-500 font-mono">HEX</span>
                          <span
                            className="text-xs text-neutral-300 font-mono font-medium truncate cursor-pointer hover:text-rose-500"
                            onClick={() => navigator.clipboard.writeText(color.hex)}
                            title="Click to copy"
                           >
                            {color.hex}
                          </span>
                      </div>
                    </div>
                  )) : (
                    <div className="col-span-full text-neutral-500 text-sm py-4 italic">
                        Palette extraction unavailable. (This usually happens if the browser caches the image without CORS headers. Try reloading with a different URL).
                    </div>
                  )}
                </div>
             </div>
          )}
        </div>

        {/* Right Col: Components List */}
        <div className="lg:col-span-4 flex flex-col h-auto lg:h-[calc(100vh-8rem)] lg:sticky lg:top-24">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl flex flex-col h-full shadow-xl overflow-hidden">

            {/* Header */}
            <div className="p-4 border-b border-neutral-800 bg-neutral-900 z-10 flex justify-between items-center shrink-0">
               <h2 className="font-semibold text-neutral-200 flex items-center gap-2">
                 <Layers className="w-4 h-4 text-rose-500" />
                 Components
                 <span className="bg-neutral-800 text-neutral-400 text-xs px-2 py-0.5 rounded-full border border-neutral-700">{crops.length}</span>
               </h2>

               <button
                  onClick={downloadAll}
                  disabled={loading || crops.length === 0}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
                      crops.length === 0
                      ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
                      : 'bg-neutral-100 hover:bg-white text-black shadow-lg shadow-white/10'
                  }`}
               >
                 {loading ? <RefreshCw className="w-3 h-3 animate-spin"/> : <Download className="w-3 h-3" />}
                 Download Kit
               </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar min-h-[300px] lg:min-h-0">
              {crops.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-neutral-600 text-center px-6 py-12">
                  <div className="w-16 h-16 rounded-full bg-neutral-800/50 flex items-center justify-center mb-4 border border-neutral-800 border-dashed">
                      <Scissors className="w-6 h-6 opacity-30" />
                  </div>
                  <p className="text-sm font-medium text-neutral-400">No assets clipped yet</p>
                  <p className="text-xs mt-2 text-neutral-500 max-w-[200px]">
                      Draw a box on the main image and click "CLIP" to instantly copy the area to your clipboard.
                      <br/><br/>
                      <span className="text-rose-500 font-bold">New:</span> Press Ctrl+V to paste images directly into this list.
                  </p>
                </div>
              ) : (
                crops.map((crop, index) => (
                  <div key={crop.id} className="bg-neutral-950 border border-neutral-800 rounded-xl p-3 flex gap-3 group hover:border-neutral-600 transition-all shadow-sm">
                    {/* Thumbnail */}
                    <div className="w-16 h-16 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] bg-neutral-900 rounded-lg overflow-hidden flex-shrink-0 border border-white/5 relative flex items-center justify-center">
                      <img src={crop.dataUrl} className="max-w-full max-h-full object-contain" alt={crop.label} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 flex flex-col justify-between min-w-0">
                      <div>
                        <input
                          value={crop.label}
                          onChange={(e) => {
                            const newCrops = [...crops];
                            newCrops[index].label = e.target.value;
                            setCrops(newCrops);
                          }}
                          className="bg-transparent text-sm font-medium text-neutral-200 outline-none border-b border-transparent focus:border-rose-500 w-full placeholder-neutral-600"
                          placeholder="Name this layer..."
                        />
                        <div className="text-[10px] text-neutral-500 mt-1 font-mono">
                          {Math.round(crop.width)}px × {Math.round(crop.height)}px
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => copyAndSearch(crop)}
                          className={`flex-1 text-[10px] py-1.5 rounded flex items-center justify-center gap-1.5 transition-colors border ${
                             copiedId === crop.id
                             ? 'bg-green-500/10 border-green-500/50 text-green-400'
                             : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border-neutral-700 hover:border-neutral-600'
                          }`}
                          title="Copy Image to Clipboard & Open Google Images"
                        >
                          {copiedId === crop.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          {copiedId === crop.id ? 'Copied!' : 'Copy & Find'}
                        </button>
                         <button
                          onClick={() => setCrops(crops.filter(c => c.id !== crop.id))}
                          className="w-7 bg-neutral-800 hover:bg-rose-900/30 hover:border-rose-500/50 border border-neutral-700 hover:text-rose-500 text-neutral-400 rounded flex items-center justify-center transition-all"
                          title="Delete"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Guide */}
            <div className="p-4 bg-neutral-800/30 border-t border-neutral-800 text-[11px] text-neutral-400 leading-relaxed shrink-0">
              <div className="flex items-start gap-2">
                <Info className="w-3 h-3 mt-0.5 flex-shrink-0 text-rose-500" />
                <div>
                  <p className="font-medium text-neutral-300 mb-1">How to find source assets:</p>
                  <ol className="list-decimal pl-3 space-y-1 text-neutral-500">
                      <li>Clip an area to copy it to your clipboard.</li>
                      <li>Paste (Ctrl+V) directly into <a href="https://images.google.com" target="_blank" className="text-rose-500 hover:underline inline-flex items-center gap-0.5">Google Images <ExternalLink className="w-2 h-2"/></a>.</li>
                  </ol>
                </div>
              </div>
            </div>

          </div>
        </div>

      </main>
    </div>
  );
};

export default App;
