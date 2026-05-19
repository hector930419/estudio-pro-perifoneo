import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { 
  Upload, Play, Pause, Square, Download, Sliders, Volume2, 
  Scissors, Trash2, Undo, BarChart3, Mic, Music, Plus, 
  ZoomIn, ZoomOut, Settings2, Sparkles, Layers, FileJson, Zap, 
  Copy, ClipboardPaste, Wand2, Activity, GripVertical, FileAudio
} from 'lucide-react';

const mensajesProcesados = new Set();

// --- UTILIDADES DSP Y EXPORTACIÓN ---
const audioBufferToWav = (buffer) => {
  const numChannels = buffer.numberOfChannels; const sampleRate = buffer.sampleRate;
  const format = 1; const bitDepth = 16;
  const result = new Float32Array(buffer.length * numChannels);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < buffer.length; i++) result[i * numChannels + channel] = channelData[i];
  }
  const dataLength = result.length * (bitDepth / 8);
  const bufferArray = new ArrayBuffer(44 + dataLength);
  const view = new DataView(bufferArray);

  const writeString = (view, offset, string) => { for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i)); };
  
  writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + dataLength, true); writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
  view.setUint16(32, numChannels * (bitDepth / 8), true); view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data'); view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < result.length; i++) {
    const s = Math.max(-1, Math.min(1, result[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true); offset += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
};

// Generador de código para el AudioWorklet (Hilo DSP Separado)
const generateWorkletCode = () => {
    return `
    class ProSaturatorProcessor extends AudioWorkletProcessor {
        process(inputs, outputs) {
            const input = inputs[0];
            const output = outputs[0];
            if (!input || !output) return true;
            for (let channel = 0; channel < input.length; ++channel) {
                const inputChannel = input[channel];
                const outputChannel = output[channel];
                for (let i = 0; i < inputChannel.length; ++i) {
                    const x = inputChannel[i];
                    // Algoritmo Soft Clipper / Saturation de cinta analógica
                    outputChannel[i] = Math.max(-1, Math.min(1, 1.5 * x - 0.5 * x * x * x)); 
                }
            }
            return true;
        }
    }
    registerProcessor('pro-saturator', ProSaturatorProcessor);
    `;
};

// Carga dinámica de LameJS para exportación MP3
const loadLameJS = async () => {
    if (window.lamejs) return true;
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js";
        script.onload = () => resolve(true);
        script.onerror = () => reject(new Error("Fallo al cargar LameJS"));
        document.head.appendChild(script);
    });
};

// Detector de Safari / iOS para prevenir ruido de estática
const isSafariOrIOS = () => {
    const ua = window.navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
    return isIOS || isSafari;
};

function makeDistortionCurve(amount) {
  let k = typeof amount === 'number' ? amount : 50;
  const n_samples = 44100; const curve = new Float32Array(n_samples); const deg = Math.PI / 180;
  for (let i = 0; i < n_samples; ++i) {
    let x = i * 2 / n_samples - 1;
    curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

const getPresetFx = (preset) => {
  let targetFx = { soundgoodizer: 10, eq: {sub:0, low:0, mid:0, highMid:0, high:0}, compresion: 30, ecoReverb: 0, deEsser: 10, chorus: 0, flanger: 0, useWorklet: false };
  switch(preset) {
    case 'neutro': targetFx = { ...targetFx, soundgoodizer: 30, eq: {sub:1, low:1, mid:0, highMid:1, high:2}, compresion: 50 }; break;
    case 'radio': targetFx = { ...targetFx, soundgoodizer: 40, eq: {sub:1.5, low:2, mid:-1, highMid:2, high:3}, compresion: 60, deEsser: 30, useWorklet: true }; break;
    case 'perifoneo': targetFx = { ...targetFx, soundgoodizer: 60, eq: {sub:-6, low:-4, mid:3, highMid:5, high:2}, compresion: 80, deEsser: 60, useWorklet: true }; break;
    case 'promo': targetFx = { ...targetFx, soundgoodizer: 80, eq: {sub:3, low:1, mid:-1, highMid:2, high:4}, compresion: 70, ecoReverb: 35, deEsser: 40, useWorklet: true }; break;
    case 'telefono': targetFx = { ...targetFx, soundgoodizer: 10, eq: {sub:-15, low:-15, mid:10, highMid:-2, high:-15}, compresion: 90, deEsser: 0 }; break;
    case 'dj_flanger': targetFx = { ...targetFx, soundgoodizer: 40, eq: {sub:1, low:1, mid:0, highMid:1, high:2}, compresion: 60, flanger: 80 }; break;
    case 'coro': targetFx = { ...targetFx, soundgoodizer: 30, eq: {sub:0, low:1, mid:0, highMid:1, high:2}, compresion: 50, chorus: 60 }; break;
    default: break;
  }
  return targetFx;
};

const getDefaultFx = (type) => ({
  soundgoodizer: type === 'voice' ? 20 : 0,
  eq: { sub: 0, low: 0, mid: 0, highMid: 0, high: 0 },
  compresion: type === 'voice' ? 30 : 0,
  ecoReverb: 0, deEsser: type === 'voice' ? 20 : 0, chorus: 0, flanger: 0, useWorklet: false
});

export default function App() {
  const [audioContext, setAudioContext] = useState(null);
  const [tracks, setTracks] = useState([]); 
  const [clips, setClips] = useState([]); 
  const [selectedClipIds, setSelectedClipIds] = useState([]);
  const [clipboard, setClipboard] = useState([]); 
  
  // ESTADOS PRINCIPALES
  const [isPlaying, setIsPlaying] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [history, setHistory] = useState([]);
  const [activePreset, setActivePreset] = useState('neutro');
  const [activeGlobalStyle, setActiveGlobalStyle] = useState('promo');

  const [autoDucking, setAutoDucking] = useState(true);
  const [isAutomationMode, setIsAutomationMode] = useState(false); 
  const [zoom, setZoom] = useState(2);
  const BASE_PPS = 20; 
  const [masterGain, setMasterGain] = useState(1);
  const [limiterEnabled, setLimiterEnabled] = useState(true);

  // =================================================================
  // 📚 CEREBRO DE LA BIBLIOTECA VIP (VERSIÓN BLINDADA Y SEGURA)
  // =================================================================
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [libraryTracks, setLibraryTracks] = useState([]);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);

  const toggleLibrary = async () => {
      setIsLibraryOpen(!isLibraryOpen);
      if (libraryTracks.length === 0 && !isLibraryOpen) {
          setIsLoadingLibrary(true);
          try {
              const res = await fetch('https://publitocancipa.com/api/listar_pistas');
              if (!res.ok) throw new Error("Error de red");
              const pistas = await res.json();
              setLibraryTracks(pistas);
          } catch (error) {
              console.error("Error cargando biblioteca VIP:", error);
          } finally {
              setIsLoadingLibrary(false);
          }
      }
  };

  const loadTrackFromLibrary = async (filename) => {
      setIsLibraryOpen(false); 
      setIsProcessing(true); 
      
      try {
          let contextoActual = audioContext;
          if (!contextoActual) {
              contextoActual = new (window.AudioContext || window.webkitAudioContext)();
              setAudioContext(contextoActual);
          }

          const res = await fetch(`https://publitocancipa.com/api/pista_preview/${filename}`);
          const arrayBuffer = await res.arrayBuffer();
          const decodedBuffer = await contextoActual.decodeAudioData(arrayBuffer);

          setTracks(prevTracks => {
              let targetTrack = prevTracks.find(t => t.type === 'music');
              let updatedTracks = [...prevTracks];

              if (!targetTrack) {
                  const typeCount = prevTracks.filter(t => t.type === 'music').length + 1;
                  // Color y valores directos para evitar errores de compilación
                  targetTrack = { id: crypto.randomUUID(), name: `Música ${typeCount}`, volume: 1.0, pan: 0, muted: false, solo: false, type: 'music', color: '#0EA5E9', hasBeenUsed: false };
                  updatedTracks.push(targetTrack);
              }

              setClips(prevClips => {
                  const exactStartTime = prevClips.filter(c => c.trackId === targetTrack.id).reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);
                  
                  const newClip = {
                      id: crypto.randomUUID(), trackId: targetTrack.id, buffer: decodedBuffer,
                      startTime: exactStartTime, offset: 0, duration: decodedBuffer.duration, fadeIn: 0.1, fadeOut: 2.5,
                      name: filename.replace('.mp3', '').toUpperCase(), volume: 1.0, 
                      fx: { soundgoodizer: 0, eq: { sub: 0, low: 0, mid: 0, highMid: 0, high: 0 }, compresion: 0, ecoReverb: 0, deEsser: 0, chorus: 0, flanger: 0, useWorklet: false }, 
                      automation: []
                  };
                  setSelectedClipIds([newClip.id]);
                  return [...prevClips, newClip];
              });

              return updatedTracks;
          });
      } catch (error) {
          console.error("Error cargando la pista VIP:", error);
          alert("Hubo un error descargando la pista desde el servidor.");
      } finally {
          setIsProcessing(false);
      }
  };
  
  

  // REFERENCIAS DIRECTAS AL DOM (Para rendimiento pro)
  const playheadRef = useRef(null);
  const timeDisplayRef = useRef(null);
  const innerContainerRef = useRef(null); 
  const scrollContainerRef = useRef(null); 
  const snapLineRef = useRef(null);

  const nodesRef = useRef({});
  const voiceInputRef = useRef(null);
  const musicInputRef = useRef(null);
  const sfxInputRef = useRef(null); 
  
  const refs = useRef({
    analyserCanvas: null, trackMeterCanvases: {}, trackAnalysers: {}, 
    request: null, meterRequest: null,
    startTime: 0, pausedAt: 0, currentTime: 0, sources: [], activeClipNodes: {},
    workletLoaded: false
  });

  const [dragState, setDragState] = useState(null); 
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [marquee, setMarquee] = useState(null); 
  const [snapPosition, setSnapPosition] = useState(null);

  const [draggedTrackIdx, setDraggedTrackIdx] = useState(null);
  const [dragOverTrackIdx, setDragOverTrackIdx] = useState(null);
  const [draggableTrackId, setDraggableTrackId] = useState(null);

  const COLORS = { voice: '#10B981', music: '#0EA5E9', sfx: '#F59E0B' }; 
  const MIN_TIMELINE_DURATION = 30; 

  const globalDuration = useMemo(() => {
    let maxTime = MIN_TIMELINE_DURATION;
    clips.forEach(c => { if (c.startTime + c.duration > maxTime) maxTime = c.startTime + c.duration + 5; });
    return maxTime;
  }, [clips]);

  refs.current.zoom = zoom;
  const timelineWidthPx = globalDuration * BASE_PPS * zoom;

  const updateDOMPlayhead = (time) => {
      refs.current.currentTime = time;
      if (playheadRef.current) {
          playheadRef.current.style.left = `${time * BASE_PPS * refs.current.zoom}px`;
      }
      if (timeDisplayRef.current) {
          const m = Math.floor(time / 60); const s = Math.floor(time % 60).toString().padStart(2, '0');
          const ms = Math.floor((time % 1) * 100).toString().padStart(2, '0');
          timeDisplayRef.current.textContent = `${m}:${s}.${ms}`;
      }
  };

// --- PUENTE DE COMUNICACIÓN (RECEPCIÓN DESDE RAILWAY) ---
// --- PUENTE DE COMUNICACIÓN (RECEPCIÓN DESDE RAILWAY) ---
  useEffect(() => {
    const recibirAudioExterno = async (event) => {
        if (event.data && (event.data.accion === 'ENVIAR_AUDIO' || event.data.accion === 'ENVIAR_AUDIO_TIEMPO')) {
            
            if (event.data.msgId) {
                if (mensajesProcesados.has(event.data.msgId)) return;
                mensajesProcesados.add(event.data.msgId);
            }

            let contextoActual = audioContext;
            if (!contextoActual) {
                contextoActual = new (window.AudioContext || window.webkitAudioContext)();
                setAudioContext(contextoActual);
            }

            setIsProcessing(true);
            pushToHistory();

            try {
                // ⬅️ Extraemos "fx" del paquete de datos
                const { arrayBuffer, tipo, nombre, startTime, duration, fadeOut, volume, fx } = event.data;
                const decodedBuffer = await contextoActual.decodeAudioData(arrayBuffer);

                setTracks(prevTracks => {
                    let targetTrack = prevTracks.find(t => t.type === tipo);
                    let updatedTracks = [...prevTracks];

                    if (!targetTrack) {
                        const typeCount = prevTracks.filter(t => t.type === tipo).length + 1;
                        const trackName = tipo === 'voice' ? `Voz ${typeCount}` : (tipo === 'music' ? `Música ${typeCount}` : `SFX ${typeCount}`);
                        targetTrack = { id: crypto.randomUUID(), name: trackName, volume: 1.0, pan: 0, muted: false, solo: false, type: tipo, color: COLORS[tipo], hasBeenUsed: false };
                        updatedTracks.push(targetTrack);
                    }

                    setClips(prevClips => {
                        let exactStartTime = 0;
                        if (startTime !== undefined) {
                            exactStartTime = startTime;
                        } else {
                            exactStartTime = prevClips.filter(c => c.trackId === targetTrack.id).reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);
                        }

                        const clipDuration = duration ? Math.min(duration, decodedBuffer.duration) : decodedBuffer.duration;
                        const clipVolume = volume !== undefined ? volume : 1.0;
                        const clipFadeOut = fadeOut !== undefined ? fadeOut : (tipo === 'music' ? 2.5 : 0.1);

                        // 🎛️ Aplicamos los efectos personalizados (fx) si vienen, si no, usamos los de defecto
                        const newClip = {
                            id: crypto.randomUUID(), trackId: targetTrack.id, buffer: decodedBuffer,
                            startTime: exactStartTime, offset: 0, duration: clipDuration, fadeIn: 0.1, fadeOut: clipFadeOut,
                            name: nombre || "Audio Importado", volume: clipVolume, 
                            fx: fx ? fx : getDefaultFx(tipo), 
                            automation: []
                        };
                        setSelectedClipIds([newClip.id]);
                        return [...prevClips, newClip];
                    });

                    return updatedTracks;
                });
            } catch (error) {
                console.error("Error recibiendo audio del puente:", error);
            } finally {
                setIsProcessing(false);
            }
        }
    };

    window.addEventListener('message', recibirAudioExterno);
    return () => window.removeEventListener('message', recibirAudioExterno);
  }, [audioContext]);
  
  
  useEffect(() => {
    const initCtx = async () => {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        
        if (!isSafariOrIOS()) {
            try {
                const blob = new Blob([generateWorkletCode()], { type: 'application/javascript' });
                await ctx.audioWorklet.addModule(URL.createObjectURL(blob));
                refs.current.workletLoaded = true;
            } catch(e) { console.warn("Worklets no soportados o fallaron", e); }
        } else {
            console.log("Safari/iOS detectado: Modo de compatibilidad segura activado (Worklets deshabilitados).");
            refs.current.workletLoaded = false;
        }

        const masterMixBus = ctx.createGain();
        const masterGainNode = ctx.createGain();
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -0.1; limiter.knee.value = 0.0; limiter.ratio.value = 20.0; limiter.attack.value = 0.001; limiter.release.value = 0.1;
        const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.8;

        masterMixBus.connect(masterGainNode);
        masterGainNode.connect(limiter); limiter.connect(analyser); analyser.connect(ctx.destination);

        nodesRef.current = { masterMixBus, masterGainNode, limiter, analyser };
        setAudioContext(ctx);
        updateDOMPlayhead(0);
    };
    initCtx();
    return () => { cancelAnimationFrame(refs.current.request); cancelAnimationFrame(refs.current.meterRequest); };
  }, []);

  useEffect(() => {
    const n = nodesRef.current; if (!n.masterGainNode) return;
    n.masterGainNode.gain.value = masterGain;
    n.masterGainNode.disconnect(); n.limiter.disconnect();
    if (limiterEnabled) { n.masterGainNode.connect(n.limiter); n.limiter.connect(n.analyser); } 
    else { n.masterGainNode.connect(n.analyser); }
  }, [masterGain, limiterEnabled]);

  useEffect(() => {
     const container = scrollContainerRef.current;
     if(!container) return;

     const handleWheel = (e) => {
         if (e.ctrlKey || e.metaKey) {
             e.preventDefault(); 
             const factor = e.deltaY > 0 ? 0.9 : 1.1;
             setZoom(z => Math.max(0.5, Math.min(8, z * factor)));
         } else if (e.shiftKey) {
             e.preventDefault();
             container.scrollLeft += e.deltaY; 
         }
     };
     container.addEventListener('wheel', handleWheel, { passive: false });
     return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedClipIds.length > 0) { e.preventDefault(); handleDeleteClip(); } }
        else if ((e.ctrlKey || e.metaKey) && e.key === 'c') { if (selectedClipIds.length > 0) { e.preventDefault(); handleCopy(); } }
        else if ((e.ctrlKey || e.metaKey) && e.key === 'v') { if (clipboard.length > 0) { e.preventDefault(); handlePaste(); } }
        else if (e.key.toLowerCase() === 's') { if (selectedClipIds.length > 0) { e.preventDefault(); handleSplit(); } }
        else if (e.key.toLowerCase() === 'a') { e.preventDefault(); setIsAutomationMode(m => !m); }
        else if (e.code === 'Space' || e.key === ' ') {
            e.preventDefault(); 
            if (tracks.length > 0) {
                if (isPlaying) pauseAudio();
                else playAudio();
            }
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedClipIds, clips, clipboard, isPlaying, tracks]);

  useEffect(() => {
    if (clips.length > 0) {
        const tracksWithClips = new Set(clips.map(c => c.trackId));
        setTracks(prev => prev.map(t => tracksWithClips.has(t.id) && !t.hasBeenUsed ? { ...t, hasBeenUsed: true } : t));
    }
  }, [clips]);

  useEffect(() => {
    if (!dragState && !isPlaying) {
        setTracks(prevTracks => {
            const tracksWithClips = new Set(clips.map(c => c.trackId));
            const nextTracks = prevTracks.filter(t => tracksWithClips.has(t.id) || !t.hasBeenUsed);
            if (nextTracks.length !== prevTracks.length) return nextTracks;
            return prevTracks;
        });
    }
  }, [clips, dragState, isPlaying]);

  const drawMeters = useCallback(() => {
    const n = nodesRef.current; 
    if (n.analyser && refs.current.analyserCanvas) {
        const canvas = refs.current.analyserCanvas; const ctx = canvas.getContext('2d');
        const width = canvas.width; const height = canvas.height;
        const bufferLength = n.analyser.frequencyBinCount; const dataArray = new Uint8Array(bufferLength);
        n.analyser.getByteFrequencyData(dataArray);
        ctx.fillStyle = '#09090b'; ctx.fillRect(0, 0, width, height); 
        const barWidth = (width / bufferLength) * 2.5; let barHeight; let x = 0;
        for (let i = 0; i < bufferLength; i++) {
          barHeight = (dataArray[i] / 255) * height;
          ctx.fillStyle = `rgb(16, 185, 129, ${barHeight/height + 0.2})`; 
          ctx.fillRect(x, height - barHeight, barWidth, barHeight); x += barWidth + 1;
        }
    }

    tracks.forEach(track => {
        const tAnalyser = refs.current.trackAnalysers[track.id];
        const tCanvas = refs.current.trackMeterCanvases[track.id];
        if (tAnalyser && tCanvas) {
            const ctx = tCanvas.getContext('2d');
            const dataArray = new Float32Array(tAnalyser.fftSize);
            tAnalyser.getFloatTimeDomainData(dataArray);
            let peak = 0; for(let i=0; i<dataArray.length; i++) if(Math.abs(dataArray[i]) > peak) peak = Math.abs(dataArray[i]);
            const db = 20 * Math.log10(Math.max(peak, 0.0001));
            const h = tCanvas.height;
            const meterHeight = Math.max(0, Math.min(1, (db + 60) / 60)) * h;
            
            ctx.fillStyle = '#18181b'; ctx.fillRect(0, 0, tCanvas.width, h);
            ctx.fillStyle = track.color; ctx.fillRect(0, h - meterHeight, tCanvas.width, meterHeight);
        }
    });
    refs.current.meterRequest = requestAnimationFrame(drawMeters);
  }, [tracks]);

  useEffect(() => {
     if (isPlaying) { refs.current.meterRequest = requestAnimationFrame(drawMeters); }
     else { cancelAnimationFrame(refs.current.meterRequest); }
     return () => cancelAnimationFrame(refs.current.meterRequest);
  }, [isPlaying, drawMeters]);

  const pushToHistory = () => {
      setHistory(prev => [...prev.slice(-15), { tracks: JSON.parse(JSON.stringify(tracks)), clips: clips.map(c => ({...c, buffer: null})) }]);
  };

  const handleUndo = () => {
    if (history.length === 0) return; stopAudio();
    const prevState = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1)); 
    setTracks(prevState.tracks); 
    const restoredClips = prevState.clips.map(c => {
        const originalClip = clips.find(oc => oc.id === c.id);
        return { ...c, buffer: originalClip ? originalClip.buffer : null };
    }).filter(c => c.buffer);
    setClips(restoredClips); setSelectedClipIds([]);
  };

  const addEmptyTrack = (type) => {
    pushToHistory();
    const typeCount = tracks.filter(t => t.type === type).length + 1;
    let name = `Pista ${typeCount}`;
    if (type === 'voice') name = `Voz ${typeCount}`;
    if (type === 'music') name = `Música ${typeCount}`;
    if (type === 'sfx') name = `SFX ${typeCount}`; 

    const newTrack = { id: crypto.randomUUID(), name, volume: 1.0, pan: 0, muted: false, solo: false, type: type, color: COLORS[type], hasBeenUsed: false };
    setTracks(prev => [...prev, newTrack]); 
    return newTrack; 
  };

  const handleFileUpload = async (e, type) => {
    const files = e.target.files; if (!files.length || !audioContext) return;
    setIsProcessing(true); pushToHistory();
    
    try {
        let targetTrack = tracks.find(t => t.type === type); 
        if (!targetTrack) targetTrack = addEmptyTrack(type);
        
        for (let file of files) {
          const arrayBuffer = await file.arrayBuffer();
          const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
          
          const newClip = {
            id: crypto.randomUUID(), trackId: targetTrack.id, buffer: decodedBuffer,
            startTime: 0, offset: 0, duration: decodedBuffer.duration, fadeIn: 0, fadeOut: 0, 
            name: file.name, volume: 1.0, fx: getDefaultFx(type), automation: [] 
          };
          
          setClips(prev => {
            const newStartTime = prev.filter(c => c.trackId === targetTrack.id).reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);
            newClip.startTime = newStartTime; return [...prev, newClip];
          });
          setSelectedClipIds([newClip.id]);
        }
    } catch (error) {
        console.error("Error subiendo el archivo de audio:", error);
    } finally {
        setIsProcessing(false);
        if (type === 'voice' && voiceInputRef.current) voiceInputRef.current.value = '';
        if (type === 'music' && musicInputRef.current) musicInputRef.current.value = '';
        if (type === 'sfx' && sfxInputRef.current) sfxInputRef.current.value = ''; 
    }
  };

  const handleCopy = () => {
      const clipsToCopy = clips.filter(c => selectedClipIds.includes(c.id));
      if (clipsToCopy.length === 0) return;
      setClipboard(JSON.parse(JSON.stringify(clipsToCopy)));
  };

  const handlePaste = () => {
      if (clipboard.length === 0) return;
      pushToHistory(); stopAudio();
      const earliestStartTime = Math.min(...clipboard.map(c => c.startTime));
      const newClips = []; const newSelectionIds = [];
      const currentT = refs.current.currentTime;

      clipboard.forEach(c => {
          const timeOffset = c.startTime - earliestStartTime;
          const newClip = { ...c, id: crypto.randomUUID(), startTime: currentT + timeOffset, buffer: clips.find(orig => orig.name === c.name)?.buffer || null };
          if(newClip.buffer) { newClips.push(newClip); newSelectionIds.push(newClip.id); }
      });
      if (newClips.length > 0) { setClips(prev => [...prev, ...newClips]); setSelectedClipIds(newSelectionIds); }
  };

  const handleSplit = () => {
    if (selectedClipIds.length === 0) return;
    const currentT = refs.current.currentTime;
    pushToHistory(); if (isPlaying) pauseAudio(); 
    
    let newSelection = [];
    setClips(prevClips => {
        let updatedClips = [...prevClips];
        selectedClipIds.forEach(id => {
            const clip = updatedClips.find(c => c.id === id);
            if (!clip || currentT <= clip.startTime || currentT >= clip.startTime + clip.duration) {
                newSelection.push(id); return;
            }
            const splitTimeLocal = currentT - clip.startTime;
            const clipA = { ...clip, id: crypto.randomUUID(), duration: splitTimeLocal, fadeOut: 0 };
            const clipB = { 
                ...clip, id: crypto.randomUUID(), startTime: currentT, 
                offset: clip.offset + splitTimeLocal, duration: clip.duration - splitTimeLocal, 
                fadeIn: 0, fx: JSON.parse(JSON.stringify(clip.fx)), automation: JSON.parse(JSON.stringify(clip.automation)) 
            };
            updatedClips = [...updatedClips.filter(c => c.id !== clip.id), clipA, clipB];
            newSelection.push(clipB.id); 
        });
        return updatedClips;
    });
    setSelectedClipIds(newSelection);
  };

  const handleDeleteClip = () => {
    if (selectedClipIds.length === 0) return; pushToHistory(); stopAudio();
    setClips(prev => prev.filter(c => !selectedClipIds.includes(c.id))); setSelectedClipIds([]);
  };

  const handleTrackDrop = (e, targetIdx) => {
    e.preventDefault();
    if (draggedTrackIdx === null || draggedTrackIdx === targetIdx) {
        setDraggedTrackIdx(null);
        setDragOverTrackIdx(null);
        return;
    }
    pushToHistory();
    setTracks(prev => {
        const newTracks = [...prev];
        const [movedTrack] = newTracks.splice(draggedTrackIdx, 1);
        newTracks.splice(targetIdx, 0, movedTrack);
        return newTracks;
    });
    setDraggedTrackIdx(null);
    setDragOverTrackIdx(null);
  };

  const getSnapPoints = (excludeClipId = null) => {
     const currentT = refs.current.currentTime;
     const points = [0, currentT];
     clips.forEach(c => { 
         if(c.id === excludeClipId) return;
         points.push(c.startTime); points.push(c.startTime + c.duration); 
     });
     return points;
  };

  const handleTimelineMouseDown = (e) => {
    if (dragState) return; 
    if (!innerContainerRef.current) return;
    
    const isMiddleClick = e.button === 1 || (e.touches && e.touches.length > 1);
    if(isMiddleClick) {
         setDragState({ type: 'pan', startX: e.clientX, startY: e.clientY, scrollLeft: scrollContainerRef.current.scrollLeft, scrollTop: scrollContainerRef.current.scrollTop });
         return;
    }

    const rect = innerContainerRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const xInside = clientX - rect.left; const yInside = clientY - rect.top;

    const isTimeRuler = e.target.closest('.time-ruler') || yInside <= 24;

    if (isTimeRuler || e.target.closest('.playhead-handle')) {
        setIsScrubbing(true); 
        const newTime = Math.max(0, xInside / (BASE_PPS * zoom));
        updateDOMPlayhead(Math.min(newTime, globalDuration));
        if (!isPlaying) refs.current.pausedAt = Math.min(newTime, globalDuration);
    } else if (e.target.closest('.timeline-bg')) {
        setMarquee({ startX: xInside, startY: yInside, currentX: xInside, currentY: yInside, initialSelection: (e.ctrlKey || e.shiftKey || e.metaKey) ? [...selectedClipIds] : [] });
        if (!e.ctrlKey && !e.shiftKey && !e.metaKey) setSelectedClipIds([]);
    }
  };

  const handleAddAutomationNode = (e, clip) => {
      if(!isAutomationMode) return;
      e.stopPropagation(); pushToHistory();
      const rect = e.currentTarget.getBoundingClientRect();
      const clickX = e.clientX - rect.left; const clickY = e.clientY - rect.top;
      
      const timeRatio = Math.max(0, Math.min(1, clickX / rect.width));
      const value = Math.max(0, Math.min(1, 1 - (clickY / rect.height))); 

      setClips(prev => prev.map(c => {
          if(c.id !== clip.id) return c;
          const newNodes = [...(c.automation || []), { id: crypto.randomUUID(), timeRatio, value }];
          newNodes.sort((a,b) => a.timeRatio - b.timeRatio);
          return { ...c, automation: newNodes };
      }));
  };

  const handleAutomationNodeMouseDown = (e, clip, nodeId) => {
      e.stopPropagation(); e.preventDefault();
      if(e.button === 2 || e.shiftKey) { 
          pushToHistory();
          setClips(prev => prev.map(c => c.id === clip.id ? { ...c, automation: c.automation.filter(n => n.id !== nodeId) } : c));
          return;
      }
      setDragState({ type: 'moveNode', clipId: clip.id, nodeId: nodeId });
  };

  const handleClipMouseDown = (e, clip) => {
    if (isAutomationMode) return; 
    e.stopPropagation(); if (e.type === 'mousedown') e.preventDefault(); 
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const clipElement = e.target.closest('.nle-clip');
    if (clipElement) {
        const rect = clipElement.getBoundingClientRect();
        const xInsideClip = clientX - rect.left;
        
        if (e.target.closest('.fade-in-handle')) { setSelectedClipIds([clip.id]); setDragState({ type: 'fadeIn', clipId: clip.id, startX: clientX, initialFade: clip.fadeIn || 0, clipDuration: clip.duration }); return; }
        else if (e.target.closest('.fade-out-handle')) { setSelectedClipIds([clip.id]); setDragState({ type: 'fadeOut', clipId: clip.id, startX: clientX, initialFade: clip.fadeOut || 0, clipDuration: clip.duration }); return; }
        else if (xInsideClip <= 10) { setSelectedClipIds([clip.id]); setDragState({ type: 'trimLeft', clipId: clip.id, startX: clientX, initialStartTime: clip.startTime, initialOffset: clip.offset, initialDuration: clip.duration }); return; } 
        else if (rect.width - xInsideClip <= 10) { setSelectedClipIds([clip.id]); setDragState({ type: 'trimRight', clipId: clip.id, startX: clientX, initialStartTime: clip.startTime, initialOffset: clip.offset, initialDuration: clip.duration }); return; }
    }

    let newSelection = [...selectedClipIds];
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
        if (newSelection.includes(clip.id)) newSelection = newSelection.filter(id => id !== clip.id); else newSelection.push(clip.id);
    } else {
        if (!newSelection.includes(clip.id)) newSelection = [clip.id];
    }
    setSelectedClipIds(newSelection);

    if (newSelection.includes(clip.id)) {
        const initialStartTimes = {}; const initialTrackIds = {};
        newSelection.forEach(id => { const c = clips.find(cx => cx.id === id); if (c) { initialStartTimes[id] = c.startTime; initialTrackIds[id] = c.trackId; } });
        setDragState({ type: 'move', mainClipId: clip.id, startX: clientX, startY: clientY, initialStartTimes, initialTrackIds, mainInitialTrackIndex: tracks.findIndex(t => t.id === clip.trackId) });
    }
  };

  useEffect(() => {
    if (!dragState && !isScrubbing && !marquee) return;

    const handleMouseMove = (e) => {
        if (!innerContainerRef.current) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const rect = innerContainerRef.current.getBoundingClientRect();

        if (dragState && dragState.type === 'pan') {
            const container = scrollContainerRef.current;
            container.scrollLeft = dragState.scrollLeft - (clientX - dragState.startX);
            container.scrollTop = dragState.scrollTop - (clientY - dragState.startY);
            return;
        }

        if (marquee) {
            const currentX = clientX - rect.left; const currentY = clientY - rect.top;
            setMarquee(prev => ({ ...prev, currentX, currentY }));

            const boxLeft = Math.min(marquee.startX, currentX); const boxRight = Math.max(marquee.startX, currentX);
            const boxTop = Math.min(marquee.startY, currentY); const boxBottom = Math.max(marquee.startY, currentY);

            const newBoxSelection = [];
            clips.forEach(clip => {
                const trackIndex = tracks.findIndex(t => t.id === clip.trackId); if (trackIndex === -1) return;
                const clipLeft = clip.startTime * BASE_PPS * zoom; const clipRight = clipLeft + (clip.duration * BASE_PPS * zoom);
                const clipTop = 24 + (trackIndex * 96); const clipBottom = clipTop + 96;
                if (!(clipRight < boxLeft || clipLeft > boxRight || clipBottom < boxTop || clipTop > boxBottom)) newBoxSelection.push(clip.id);
            });
            setSelectedClipIds([...new Set([...marquee.initialSelection, ...newBoxSelection])]);
        }
        else if (isScrubbing) {
            const clickXInsideContainer = clientX - rect.left;
            const newTime = Math.max(0, clickXInsideContainer / (BASE_PPS * zoom));
            updateDOMPlayhead(Math.min(newTime, globalDuration));
            refs.current.pausedAt = Math.min(newTime, globalDuration);
        } 
        else if (dragState) {
            if (dragState.type === 'moveNode') {
                 const clipElement = document.getElementById(`clip-${dragState.clipId}`);
                 if(!clipElement) return;
                 const clipRect = clipElement.getBoundingClientRect();
                 const xInside = Math.max(0, Math.min(clipRect.width, clientX - clipRect.left));
                 const yInside = Math.max(0, Math.min(clipRect.height, clientY - clipRect.top));
                 
                 setClips(prev => prev.map(c => {
                     if(c.id !== dragState.clipId) return c;
                     const newNodes = c.automation.map(n => n.id === dragState.nodeId ? { ...n, timeRatio: xInside / clipRect.width, value: 1 - (yInside / clipRect.height) } : n);
                     newNodes.sort((a,b) => a.timeRatio - b.timeRatio);
                     return { ...c, automation: newNodes };
                 }));
                 return;
            }

            const deltaX = clientX - dragState.startX;
            const deltaTime = deltaX / (BASE_PPS * zoom); 

            if (dragState.type === 'move') {
                let mainHoveredTrackId = dragState.initialTrackIds[dragState.mainClipId]; 
                const mainClipType = tracks.find(t => t.id === mainHoveredTrackId)?.type || 'voice';

                document.querySelectorAll('.track-dropzone').forEach((row) => {
                    const rowRect = row.getBoundingClientRect();
                    if (clientY >= rowRect.top && clientY <= rowRect.bottom) {
                        const trackId = row.dataset.trackid;
                        if (trackId === 'new-track') {
                            mainHoveredTrackId = 'new-track';
                        } else {
                            const destTrack = tracks.find(t => t.id === trackId);
                            if (destTrack && destTrack.type === mainClipType) {
                                mainHoveredTrackId = trackId;
                            }
                        }
                    }
                });

                if (mainHoveredTrackId === 'new-track' && !dragState.newTrackId) {
                    const typeCount = tracks.filter(t => t.type === mainClipType).length + 1;
                    let name = `Pista ${typeCount}`;
                    if (mainClipType === 'voice') name = `Voz ${typeCount}`;
                    if (mainClipType === 'music') name = `Música ${typeCount}`;
                    if (mainClipType === 'sfx') name = `SFX ${typeCount}`;

                    const newTrack = { 
                        id: crypto.randomUUID(), name, volume: 1.0, pan: 0, muted: false, solo: false, type: mainClipType, color: COLORS[mainClipType], hasBeenUsed: true 
                    };
                    setTracks(prev => [...prev, newTrack]);
                    setDragState(prev => ({ ...prev, newTrackId: newTrack.id }));
                    mainHoveredTrackId = newTrack.id;
                } else if (mainHoveredTrackId === 'new-track' && dragState.newTrackId) {
                    mainHoveredTrackId = dragState.newTrackId;
                }

                const snapPoints = getSnapPoints(dragState.mainClipId);
                const snapThreshold = 15 / (BASE_PPS * zoom); 
                let currentSnap = null;

                setClips(prev => prev.map(c => {
                    if (dragState.initialStartTimes[c.id] !== undefined) {
                        let newStartTime = Math.max(0, dragState.initialStartTimes[c.id] + deltaTime);
                        
                        if (c.id === dragState.mainClipId) {
                           let minDiff = snapThreshold;
                           snapPoints.forEach(p => {
                               if (Math.abs(newStartTime - p) < minDiff) { minDiff = Math.abs(newStartTime - p); newStartTime = p; currentSnap = p; }
                               else if (Math.abs((newStartTime + c.duration) - p) < minDiff) { minDiff = Math.abs((newStartTime + c.duration) - p); newStartTime = p - c.duration; currentSnap = p; }
                           });
                        } else {
                           const mainClip = prev.find(mc => mc.id === dragState.mainClipId);
                           if (mainClip) {
                               newStartTime = Math.max(0, mainClip.startTime + (dragState.initialStartTimes[c.id] - dragState.initialStartTimes[mainClip.id]));
                           }
                        }
                        return { ...c, startTime: newStartTime, trackId: mainHoveredTrackId };
                    }
                    return c;
                }));
                setSnapPosition(currentSnap);
            } 
            else if (dragState.type === 'trimRight' || dragState.type === 'trimLeft') {
                const snapPoints = getSnapPoints(dragState.clipId); 
                const snapThreshold = 15 / (BASE_PPS * zoom);
                let currentSnap = null;

                setClips(prev => prev.map(c => {
                    if (c.id === dragState.clipId) {
                        if(dragState.type === 'trimRight') {
                            const maxAllowedDuration = c.buffer.duration - c.offset;
                            let newDuration = Math.max(0.1, Math.min(dragState.initialDuration + deltaTime, maxAllowedDuration));
                            snapPoints.forEach(p => { if (Math.abs((c.startTime + newDuration) - p) < snapThreshold) { newDuration = p - c.startTime; currentSnap = p; }});
                            return { ...c, duration: newDuration };
                        } else {
                            const actualDeltaTime = Math.max(-dragState.initialOffset, deltaTime);
                            let newOffset = Math.max(0, dragState.initialOffset + actualDeltaTime);
                            let newDuration = Math.max(0.1, dragState.initialDuration - actualDeltaTime);
                            let newStartTime = Math.max(0, dragState.initialStartTime + actualDeltaTime);
                            snapPoints.forEach(p => { if (Math.abs(newStartTime - p) < snapThreshold) { const diff = p - newStartTime; newStartTime = p; newOffset += diff; newDuration -= diff; currentSnap = p; } });
                            return { ...c, offset: newOffset, duration: newDuration, startTime: newStartTime };
                        }
                    }
                    return c;
                }));
                setSnapPosition(currentSnap);
            }
            else if (dragState.type === 'fadeIn' || dragState.type === 'fadeOut') {
                setClips(prev => prev.map(c => {
                    if (c.id === dragState.clipId) {
                        if(dragState.type === 'fadeIn') return { ...c, fadeIn: Math.max(0, Math.min(c.duration, dragState.initialFade + deltaTime)) };
                        if(dragState.type === 'fadeOut') return { ...c, fadeOut: Math.max(0, Math.min(c.duration, dragState.initialFade - deltaTime)) };
                    } return c;
                }));
            }
        }
    };

    const handleMouseUp = () => {
        if (isScrubbing) setIsScrubbing(false);
        if (marquee) setMarquee(null); 
        if (dragState) { 
             if(dragState.type !== 'pan' && dragState.type !== 'moveNode') pushToHistory(); 
             setDragState(null); setSnapPosition(null);
        }
    };

    window.addEventListener('mousemove', handleMouseMove); window.addEventListener('mouseup', handleMouseUp);
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp); };
  }, [dragState, isScrubbing, marquee, globalDuration, zoom, tracks, clips, isAutomationMode]);

  const buildClipDSP = (audioCtx, clip, trackGain, ctxStart, playStart, trackType) => {
     const clipGain = audioCtx.createGain(); 
     
     const offsetDentroDelClip = Math.max(0, playStart - clip.startTime);
     const actualPlayDuration = clip.duration - offsetDentroDelClip;
     const realStartTime = ctxStart + Math.max(0, clip.startTime - playStart);
     const realEndTime = realStartTime + actualPlayDuration;
     
     const fi = Math.max(0.01, clip.fadeIn || 0);
     const fo = Math.max(0.01, clip.fadeOut || 0);

     clipGain.gain.setValueAtTime(0, Math.max(ctxStart, realStartTime - 0.001));
     const fadeInEnd = Math.min(realEndTime, realStartTime + fi);
     clipGain.gain.linearRampToValueAtTime(clip.volume, fadeInEnd);

     let lastTimeDucking = fadeInEnd;
     if (autoDucking && trackType === 'music') {
        const voiceClips = clips.filter(c => { const t = tracks.find(tr => tr.id === c.trackId); return t && t.type === 'voice' && !t.muted; })
                                .map(c => ({ start: ctxStart + (c.startTime - playStart), end: ctxStart + (c.startTime + c.duration - playStart) }))
                                .sort((a, b) => a.start - b.start);

        const mergedVoices = [];
        if (voiceClips.length > 0) {
            let current = { start: voiceClips[0].start, end: voiceClips[0].end };
            for (let i = 1; i < voiceClips.length; i++) {
                if (voiceClips[i].start <= current.end + 0.5) current.end = Math.max(current.end, voiceClips[i].end);
                else { mergedVoices.push(current); current = { start: voiceClips[i].start, end: voiceClips[i].end }; }
            }
            mergedVoices.push(current);
        }

        mergedVoices.forEach(block => {
           if (block.end <= realStartTime || block.start >= realEndTime) return;
           const duckStart = Math.max(lastTimeDucking, block.start);
           const duckFull = Math.max(duckStart, block.start + 0.15);
           const releaseStart = Math.max(duckFull, block.end - 0.8);
           const releaseEnd = Math.min(realEndTime - fo, block.end + 0.1); 

           if (duckStart > lastTimeDucking) clipGain.gain.setValueAtTime(clip.volume, duckStart); 
           if (duckFull > duckStart) clipGain.gain.linearRampToValueAtTime(clip.volume * 0.25, duckFull); else clipGain.gain.setValueAtTime(clip.volume * 0.25, duckFull); 
           if (releaseStart > duckFull) clipGain.gain.setValueAtTime(clip.volume * 0.25, releaseStart); 
           if (releaseEnd > releaseStart) clipGain.gain.linearRampToValueAtTime(clip.volume, releaseEnd); else clipGain.gain.setValueAtTime(clip.volume, releaseEnd); 
           lastTimeDucking = releaseEnd;
        });
     }

     if (clip.automation && clip.automation.length > 0 && (!autoDucking || trackType !== 'music')) {
         clipGain.gain.cancelScheduledValues(realStartTime);
         clipGain.gain.setValueAtTime(clip.volume, Math.max(ctxStart, realStartTime));
         
         clip.automation.forEach(node => {
             const nodeTime = realStartTime + (node.timeRatio * clip.duration);
             if (nodeTime >= realStartTime && nodeTime <= realEndTime) {
                 clipGain.gain.linearRampToValueAtTime(node.value * clip.volume, nodeTime);
             }
         });
     } else if (!autoDucking || trackType !== 'music') {
         clipGain.gain.setValueAtTime(clip.volume, Math.max(lastTimeDucking, realEndTime - fo));
     }

     clipGain.gain.linearRampToValueAtTime(0, realEndTime);

     const fx = clip.fx || getDefaultFx(trackType);

     let currentNode = clipGain;
     const activeNodes = {};

     const headroomGain = audioCtx.createGain(); headroomGain.gain.value = 0.7; 
     currentNode.connect(headroomGain); currentNode = headroomGain;

     const eqSub = audioCtx.createBiquadFilter(); eqSub.type = 'lowshelf'; eqSub.frequency.value = 90; eqSub.gain.value = fx.eq.sub;
     const eqLow = audioCtx.createBiquadFilter(); eqLow.type = 'peaking'; eqLow.frequency.value = 250; eqLow.Q.value = 0.8; eqLow.gain.value = fx.eq.low;
     const eqMid = audioCtx.createBiquadFilter(); eqMid.type = 'peaking'; eqMid.frequency.value = 1500; eqMid.Q.value = 0.8; eqMid.gain.value = fx.eq.mid;
     const eqHighMid = audioCtx.createBiquadFilter(); eqHighMid.type = 'peaking'; eqHighMid.frequency.value = 4000; eqHighMid.Q.value = 0.8; eqHighMid.gain.value = fx.eq.highMid;
     const eqHigh = audioCtx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 8000; eqHigh.gain.value = fx.eq.high;
     const deEsserNode = audioCtx.createBiquadFilter(); deEsserNode.type = 'peaking'; deEsserNode.frequency.value = 6500; deEsserNode.Q.value = 2.5; deEsserNode.gain.value = -(fx.deEsser/100) * 18;
     
     currentNode.connect(eqSub); eqSub.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHighMid); eqHighMid.connect(eqHigh); eqHigh.connect(deEsserNode);
     currentNode = deEsserNode;

     let exciterGain;
     let waveShaper;

     if (fx.useWorklet && refs.current.workletLoaded) {
         try {
             const workletNode = new AudioWorkletNode(audioCtx, 'pro-saturator');
             currentNode.connect(workletNode);
             currentNode = workletNode;
             activeNodes.worklet = workletNode;
         } catch(e) { console.warn("Fallback de Worklet a WaveShaper"); }
     } else {
         const exciterHPF = audioCtx.createBiquadFilter(); exciterHPF.type = 'highpass'; exciterHPF.frequency.value = 3000;
         exciterGain = audioCtx.createGain(); exciterGain.gain.value = (fx.soundgoodizer/100) * 0.15; 
         waveShaper = audioCtx.createWaveShaper(); waveShaper.curve = makeDistortionCurve(10 + ((fx.soundgoodizer/100)*100));
         currentNode.connect(exciterHPF); exciterHPF.connect(waveShaper); waveShaper.connect(exciterGain);
         
         const sum = audioCtx.createGain();
         currentNode.connect(sum); exciterGain.connect(sum);
         currentNode = sum;
     }

     const comp = audioCtx.createDynamicsCompressor(); comp.knee.value = 5; comp.attack.value = 0.005; comp.release.value = 0.1;
     const compMakeUp = audioCtx.createGain();
     const compPct = fx.compresion / 100; 
     comp.threshold.value = -12 - (compPct * 18); comp.ratio.value = 2 + (compPct * 6); compMakeUp.gain.value = 1 + (compPct * 1.5); 
     currentNode.connect(comp); comp.connect(compMakeUp);
     currentNode = compMakeUp;

     const flangerDry = audioCtx.createGain(); flangerDry.gain.value = 1 - ((fx.flanger || 0)/100 * 0.5);
     const flangerWet = audioCtx.createGain(); flangerWet.gain.value = (fx.flanger || 0)/100;
     const flangerDelay = audioCtx.createDelay(0.02); flangerDelay.delayTime.value = 0.005;
     const flangerFeedback = audioCtx.createGain(); flangerFeedback.gain.value = 0.7;
     const flangerOsc = audioCtx.createOscillator(); flangerOsc.type = 'sine'; flangerOsc.frequency.value = 0.5; 
     const flangerOscGain = audioCtx.createGain(); flangerOscGain.gain.value = 0.003;
     flangerOsc.connect(flangerOscGain); flangerOscGain.connect(flangerDelay.delayTime); flangerOsc.start(ctxStart);

     const chorusDry = audioCtx.createGain(); chorusDry.gain.value = 1 - ((fx.chorus || 0)/100 * 0.5);
     const chorusWet = audioCtx.createGain(); chorusWet.gain.value = (fx.chorus || 0)/100;
     const chorusDelay = audioCtx.createDelay(0.05); chorusDelay.delayTime.value = 0.025;
     const chorusOsc = audioCtx.createOscillator(); chorusOsc.type = 'sine'; chorusOsc.frequency.value = 1.5;
     const chorusOscGain = audioCtx.createGain(); chorusOscGain.gain.value = 0.01;
     chorusOsc.connect(chorusOscGain); chorusOscGain.connect(chorusDelay.delayTime); chorusOsc.start(ctxStart);

     const dryGain = audioCtx.createGain(); dryGain.gain.value = Math.max(0, 1 - ((fx.ecoReverb/100) * 0.4));
     const delayMix = audioCtx.createGain(); delayMix.gain.value = (fx.ecoReverb/100) * 0.8;
     const delayNode = audioCtx.createDelay(2.0); delayNode.delayTime.value = 0.35;
     const delayFeedback = audioCtx.createGain(); delayFeedback.gain.value = 0.3;
     const clipOutGain = audioCtx.createGain(); 

     currentNode.connect(flangerDry); currentNode.connect(flangerDelay);
     flangerDelay.connect(flangerFeedback); flangerFeedback.connect(flangerDelay); flangerDelay.connect(flangerWet);
     
     flangerDry.connect(chorusDry); flangerDry.connect(chorusDelay);
     flangerWet.connect(chorusDry); flangerWet.connect(chorusDelay); chorusDelay.connect(chorusWet);

     chorusDry.connect(dryGain); chorusDry.connect(delayNode); 
     chorusWet.connect(dryGain); chorusWet.connect(delayNode); 

     delayNode.connect(delayFeedback); delayFeedback.connect(delayNode); delayNode.connect(delayMix);
     
     dryGain.connect(clipOutGain); delayMix.connect(clipOutGain); clipOutGain.connect(trackGain);

     return { 
       inputNode: clipGain, 
       activeNodes: { 
         eqSub, eqLow, eqMid, eqHighMid, eqHigh, deEsserNode, exciterGain, waveShaper, comp, compMakeUp, dryGain, delayMix,
         flangerDry, flangerWet, chorusDry, chorusWet
       } 
     };
  };

  const updateProgress = () => {
    const elapsed = audioContext.currentTime - refs.current.startTime + refs.current.pausedAt;
    updateDOMPlayhead(elapsed);
    
    if (scrollContainerRef.current) {
        const container = scrollContainerRef.current;
        const playheadPx = elapsed * BASE_PPS * refs.current.zoom;
        if (playheadPx > container.scrollLeft + container.clientWidth * 0.8) {
            container.scrollLeft = playheadPx - container.clientWidth * 0.2;
        }
    }

    if (elapsed >= globalDuration) stopAudio(); 
    else { refs.current.request = requestAnimationFrame(updateProgress); }
  };

  const playAudio = () => {
    if (clips.length === 0 || !audioContext) return;
    if (audioContext.state === 'suspended') audioContext.resume();

    const isAnySolo = tracks.some(t => t.solo);
    const playStart = refs.current.currentTime;
    const ctxStart = audioContext.currentTime;

    if(!refs.current.trackAnalysers) refs.current.trackAnalysers = {};
    refs.current.activeClipNodes = {}; 

    refs.current.sources = clips.map(clip => {
      const track = tracks.find(t => t.id === clip.trackId);
      if (!track || (track.muted && !track.solo) || (isAnySolo && !track.solo)) return null;
      if (clip.startTime + clip.duration <= playStart) return null; 

      const source = audioContext.createBufferSource(); source.buffer = clip.buffer;
      const trackGain = audioContext.createGain(); trackGain.gain.value = track.volume;
      const trackPan = audioContext.createStereoPanner(); trackPan.pan.value = track.pan || 0;

      if(!refs.current.trackAnalysers[track.id]) {
          const a = audioContext.createAnalyser(); a.fftSize = 256; a.smoothingTimeConstant = 0.5;
          refs.current.trackAnalysers[track.id] = a;
      }

      const { inputNode, activeNodes } = buildClipDSP(audioContext, clip, trackGain, ctxStart, playStart, track.type);
      refs.current.activeClipNodes[clip.id] = activeNodes; 
      
      trackGain.connect(trackPan); trackPan.connect(refs.current.trackAnalysers[track.id]); trackPan.connect(nodesRef.current.masterMixBus); 
      
      const offsetDentroDelClip = Math.max(0, playStart - clip.startTime);
      const tiempoEsperaReal = Math.max(0, clip.startTime - playStart);

      source.connect(inputNode);
      source.start(ctxStart + tiempoEsperaReal, clip.offset + offsetDentroDelClip, clip.duration - offsetDentroDelClip); 
      return source;
    }).filter(Boolean);

    refs.current.startTime = ctxStart; refs.current.pausedAt = playStart;
    setIsPlaying(true); refs.current.request = requestAnimationFrame(updateProgress);
  };

  const pauseAudio = () => { refs.current.sources.forEach(s => s.stop()); refs.current.sources = []; refs.current.activeClipNodes = {}; refs.current.pausedAt = refs.current.currentTime; setIsPlaying(false); cancelAnimationFrame(refs.current.request); };
  const stopAudio = () => { refs.current.sources.forEach(s => s.stop()); refs.current.sources = []; refs.current.activeClipNodes = {}; setIsPlaying(false); refs.current.pausedAt = 0; updateDOMPlayhead(0); cancelAnimationFrame(refs.current.request); if (refs.current.analyserCanvas) refs.current.analyserCanvas.getContext('2d').clearRect(0, 0, 300, 150); };

  const exportProjectJSON = () => {
    const projectState = {
      tracks: tracks.map(t => ({ id: t.id, name: t.name, type: t.type, volume: t.volume, pan: t.pan, muted: t.muted, color: t.color })),
      clips: clips.map(c => ({ id: c.id, trackId: c.trackId, name: c.name, startTime: c.startTime, offset: c.offset, duration: c.duration, fadeIn: c.fadeIn, fadeOut: c.fadeOut, volume: c.volume, fx: c.fx, automation: c.automation })),
      mastering: { masterGain, autoDucking, activePreset }
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(projectState, null, 2));
    const a = document.createElement('a'); a.href = dataStr; a.download = "proyecto_estudio.json"; a.click();
  };

  const formatTime = (t) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}.${Math.floor((t % 1) * 100).toString().padStart(2, '0')}`;
  const updateTrackProp = (id, props) => setTracks(prev => prev.map(t => t.id === id ? { ...t, ...props } : t));
  const deleteTrack = (id) => { pushToHistory(); stopAudio(); setTracks(prev => prev.filter(t => t.id !== id)); setClips(prev => prev.filter(c => c.trackId !== id)); };

  const exportMaster = async (format = 'wav') => {
    if (clips.length === 0) return; setIsProcessing(true);
    let renderDuration = 0; clips.forEach(c => { if(c.startTime + c.duration > renderDuration) renderDuration = c.startTime + c.duration; }); renderDuration += 1.5; 

    // Añadido prefijo webkitOfflineAudioContext para Safari
    const OfflineCtxClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offlineCtx = new OfflineCtxClass(2, audioContext.sampleRate * renderDuration, audioContext.sampleRate);
    
    // Solo inyectar worklet si no estamos en Safari
    if (refs.current.workletLoaded && !isSafariOrIOS()) {
        try {
            const blob = new Blob([generateWorkletCode()], { type: 'application/javascript' });
            await offlineCtx.audioWorklet.addModule(URL.createObjectURL(blob));
        } catch(e){}
    }

    const masterMix = offlineCtx.createGain();
    const masterNode = offlineCtx.createGain(); masterNode.gain.value = masterGain;
    const limiter = offlineCtx.createDynamicsCompressor(); limiter.threshold.value = -0.1; limiter.ratio.value = 20.0; limiter.attack.value = 0.001;
    
    masterMix.connect(masterNode);
    if (limiterEnabled) { masterNode.connect(limiter); limiter.connect(offlineCtx.destination); } else { masterNode.connect(offlineCtx.destination); }

    const isAnySolo = tracks.some(t => t.solo);
    clips.forEach(clip => {
      const track = tracks.find(t => t.id === clip.trackId);
      if (!track || (track.muted && !track.solo) || (isAnySolo && !track.solo)) return;

      const source = offlineCtx.createBufferSource(); source.buffer = clip.buffer;
      const trackGain = offlineCtx.createGain(); trackGain.gain.value = track.volume;
      const trackPan = offlineCtx.createStereoPanner(); trackPan.pan.value = track.pan || 0;
      
      const { inputNode } = buildClipDSP(offlineCtx, clip, trackGain, 0, 0, track.type);
      trackGain.connect(trackPan); trackPan.connect(masterMix);
      source.connect(inputNode); source.start(clip.startTime, clip.offset, clip.duration); 
    });
    
    const renderedBuffer = await offlineCtx.startRendering();

    if (format === 'mp3') {
        try {
            await loadLameJS();
            const channels = 2; const sampleRate = renderedBuffer.sampleRate; const kbps = 128;
            const mp3encoder = new window.lamejs.Mp3Encoder(channels, sampleRate, kbps);
            
            const leftData = renderedBuffer.getChannelData(0);
            const rightData = renderedBuffer.numberOfChannels > 1 ? renderedBuffer.getChannelData(1) : leftData;
            
            const sampleBlockSize = 1152;
            const mp3Data = [];
            
            const floatToInt16 = (f32Arr) => {
                const i16Arr = new Int16Array(f32Arr.length);
                for(let i=0; i<f32Arr.length; i++) {
                    const s = Math.max(-1, Math.min(1, f32Arr[i]));
                    i16Arr[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                return i16Arr;
            };

            const leftInt16 = floatToInt16(leftData);
            const rightInt16 = floatToInt16(rightData);

            for (let i = 0; i < leftInt16.length; i += sampleBlockSize) {
                const leftChunk = leftInt16.subarray(i, i + sampleBlockSize);
                const rightChunk = rightInt16.subarray(i, i + sampleBlockSize);
                const mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
                if (mp3buf.length > 0) mp3Data.push(mp3buf);
            }
            const mp3buf = mp3encoder.flush(); if (mp3buf.length > 0) mp3Data.push(mp3buf);
            
            const blob = new Blob(mp3Data, { type: 'audio/mp3' });
            const url = URL.createObjectURL(blob); const a = document.createElement('a');
            a.href = url; a.download = `Audio_Pro_Master.mp3`; a.click(); URL.revokeObjectURL(url);
        } catch (e) {
            console.error("Error exportando a MP3:", e);
            alert("No se pudo exportar a MP3, usando WAV como respaldo.");
            exportMaster('wav'); 
        }
    } else {
        const wavBlob = audioBufferToWav(renderedBuffer);
        const url = URL.createObjectURL(wavBlob); const a = document.createElement('a');
        a.href = url; a.download = `Audio_Pro_Master.wav`; a.click(); URL.revokeObjectURL(url);
    }
    setIsProcessing(false);
  };

  const handleRemoveSilence = () => {
    if (selectedClipIds.length === 0) return;
    pushToHistory(); stopAudio(); setIsProcessing(true);

    setTimeout(() => {
        let newClipsArray = [...clips]; 
        let newSelectionIds = [];

        // Agrupamos los clips seleccionados por pista
        const trackIds = [...new Set(selectedClipIds.map(id => clips.find(c => c.id === id)?.trackId).filter(Boolean))];

        trackIds.forEach(trackId => {
            let trackClips = newClipsArray.filter(c => c.trackId === trackId).sort((a,b) => a.startTime - b.startTime);
            let processedTrackClips = [];
            
            let shiftDelta = 0;
            let isMagnetActive = false;
            let magnetHead = 0;

            trackClips.forEach(clip => {
                if (selectedClipIds.includes(clip.id)) {
                    const buffer = clip.buffer; const channelData = buffer.getChannelData(0); const sampleRate = buffer.sampleRate;
                    const startSampleObj = Math.floor(clip.offset * sampleRate);
                    const endSampleObj = Math.floor((clip.offset + clip.duration) * sampleRate);

                    let maxPeak = 0;
                    for (let p = startSampleObj; p < endSampleObj; p += 10) if (Math.abs(channelData[p]) > maxPeak) maxPeak = Math.abs(channelData[p]);
                    
                    const threshold = Math.max(0.015, maxPeak * 0.08);
                    const minSilenceSamples = sampleRate * 0.12; 
                    const paddingSamples = sampleRate * 0.015; 
                    const chunkSize = Math.floor(sampleRate * 0.005); 

                    let segments = []; let currentSegment = null; let silenceCounter = 0;

                    for (let i = startSampleObj; i < endSampleObj; i += chunkSize) {
                        let max = 0;
                        for (let j = 0; j < chunkSize && i + j < endSampleObj; j++) {
                            if (Math.abs(channelData[i + j]) > max) max = Math.abs(channelData[i + j]);
                        }
                        
                        if (max > threshold) {
                            if (!currentSegment) currentSegment = { start: Math.max(startSampleObj, i - paddingSamples), end: 0 };
                            silenceCounter = 0; currentSegment.end = Math.min(endSampleObj, i + chunkSize + paddingSamples);
                        } else {
                            if (currentSegment) {
                                silenceCounter += chunkSize;
                                if (silenceCounter >= minSilenceSamples) { segments.push(currentSegment); currentSegment = null; silenceCounter = 0; }
                            }
                        }
                    }
                    if (currentSegment) segments.push(currentSegment);

                    if (segments.length > 0) {
                        if (!isMagnetActive) {
                            magnetHead = clip.startTime;
                            isMagnetActive = true;
                        }

                        segments.forEach((seg, idx) => {
                            const newOffset = seg.start / sampleRate;
                            const newDuration = (seg.end - seg.start) / sampleRate;
                            if (newDuration <= 0) return;

                            const newClipId = crypto.randomUUID();
                            processedTrackClips.push({
                                ...clip, id: newClipId, startTime: magnetHead, offset: newOffset, duration: newDuration,
                                fadeIn: 0.01, fadeOut: 0.01,
                                name: `${clip.name} (T${idx+1})`, fx: JSON.parse(JSON.stringify(clip.fx)), automation: []
                            });
                            newSelectionIds.push(newClipId);
                            magnetHead += newDuration; 
                        });
                        
                        const originalEndTime = clip.startTime + clip.duration;
                        shiftDelta = originalEndTime - magnetHead;
                    } else {
                        const originalEndTime = clip.startTime + clip.duration;
                        if (!isMagnetActive) shiftDelta = originalEndTime - clip.startTime;
                        else shiftDelta = originalEndTime - magnetHead;
                    }
                } else {
                    if (isMagnetActive) {
                        let newStartTime = clip.startTime - shiftDelta;
                        if (newStartTime < magnetHead) newStartTime = magnetHead; 
                        processedTrackClips.push({ ...clip, startTime: newStartTime });
                        magnetHead = newStartTime + clip.duration;
                        shiftDelta = (clip.startTime + clip.duration) - magnetHead;
                    } else {
                        processedTrackClips.push(clip);
                    }
                }
            });

            newClipsArray = newClipsArray.filter(c => c.trackId !== trackId).concat(processedTrackClips);
        });

        setClips(newClipsArray); setSelectedClipIds(newSelectionIds); setIsProcessing(false);
    }, 10);
  };

  const applyGlobalStyle = (styleName) => {
      setActiveGlobalStyle(styleName);
      pushToHistory();
      
      setClips(prevClips => {
          const voiceTrackIds = tracks.filter(t => t.type === 'voice').map(t => t.id);
          let newClips = [...prevClips];

          voiceTrackIds.forEach(trackId => {
              const trackClips = newClips.filter(c => c.trackId === trackId).sort((a,b) => a.startTime - b.startTime);
              if(trackClips.length === 0) return;

              trackClips.forEach((clip, index) => {
                  let presetToApply = 'neutro'; 
                  const isFirst = index === 0;
                  const isLast = index === trackClips.length - 1;

                  if (styleName === 'classic') {
                      presetToApply = 'neutro'; 
                  } else if (styleName === 'promo') {
                      presetToApply = (isLast && trackClips.length > 1) ? 'promo' : 'neutro';
                  } else if (styleName === 'dj') {
                      if (isFirst && trackClips.length > 1) presetToApply = 'dj_flanger';
                      else if (isLast && trackClips.length > 2) presetToApply = 'coro';
                      else presetToApply = 'neutro';
                  } else if (styleName === 'urbano') {
                      if (isFirst && trackClips.length > 1) presetToApply = 'telefono';
                      else if (isLast && trackClips.length > 2) presetToApply = 'coro';
                      else presetToApply = 'neutro';
                  }
                  
                  const targetFx = getPresetFx(presetToApply);
                  const clipIndex = newClips.findIndex(c => c.id === clip.id);
                  newClips[clipIndex] = { ...clip, fx: targetFx, name: `Voz (${presetToApply})` };
              });
          });
          return newClips;
      });
  };

  const updateClipVolume = (vol) => setClips(prev => prev.map(c => selectedClipIds.includes(c.id) ? { ...c, volume: vol } : c));

  const applyPreset = (preset) => {
    if (selectedClipIds.length === 0) return;
    setActivePreset(preset);
    const targetFx = getPresetFx(preset);
    setClips(prev => prev.map(c => selectedClipIds.includes(c.id) ? { ...c, fx: targetFx } : c));
  };

  const updateClipFx = (fxKey, value, subKey = null) => {
    if (selectedClipIds.length === 0) return;
    setClips(prev => prev.map(c => {
        if (!selectedClipIds.includes(c.id)) return c;
        const newFx = { ...c.fx };
        if (subKey) newFx[fxKey] = { ...newFx[fxKey], [subKey]: value }; else newFx[fxKey] = value;
        return { ...c, fx: newFx };
    }));
  };

  const primaryClip = clips.find(c => c.id === selectedClipIds[0]);
  const activeFx = primaryClip ? primaryClip.fx : null;

  return (
    <div className="h-screen overflow-y-auto overflow-x-hidden w-full bg-zinc-950 text-zinc-200 font-sans p-4 sm:p-6 selection:bg-emerald-500 selection:text-white flex flex-col gap-6 relative custom-scrollbar">
      
{/* --- HEADER ORIGINAL Y BOTONES --- */}
      <header className="flex flex-col md:flex-row justify-between items-center border-b border-zinc-800 pb-4 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-lg shadow-[0_0_15px_rgba(16,185,129,0.3)]">
            <Layers className="w-6 h-6 text-zinc-900" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white leading-tight">ProStudio <span className="bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-teal-400 text-sm uppercase tracking-widest ml-1 font-black">PERIFONEO.AI</span></h1>
            <p className="text-[10px] text-emerald-400 font-mono tracking-widest uppercase font-bold flex items-center gap-1">
              Motor de Edición Integrado
            </p>
          </div>
        </div>
        <div className="flex gap-4 items-center flex-wrap justify-center">
          
          <button onClick={() => voiceInputRef.current?.click()} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded font-bold transition-all text-sm">
             <Mic className="w-4 h-4" /> Voz (IA / Mic)
          </button>
          
          <button onClick={() => musicInputRef.current?.click()} className="flex items-center gap-2 bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 rounded font-bold transition-all text-sm" title="Subir música desde tu PC">
             <Music className="w-4 h-4" /> Mi Música
          </button>

          {/* 🌟 NUEVO: BOTÓN Y MENÚ DE BIBLIOTECA VIP */}
          <div className="relative">
              <button onClick={toggleLibrary} className="flex items-center gap-2 bg-gradient-to-r from-fuchsia-600 to-purple-600 hover:from-fuchsia-500 hover:to-purple-500 text-white px-4 py-2 rounded font-bold transition-all text-sm shadow-[0_0_15px_rgba(192,38,211,0.4)] border border-fuchsia-400/50">
                  ⭐ Pistas VIP
              </button>
              
              {/* EL MENÚ DESPLEGABLE */}
              {isLibraryOpen && (
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 mt-3 w-72 bg-zinc-900 border border-fuchsia-500/50 rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.8)] z-[100] max-h-80 flex flex-col overflow-hidden">
                      <div className="p-3 border-b border-zinc-800 flex justify-between items-center bg-zinc-950">
                          <span className="text-xs font-black text-fuchsia-400 uppercase tracking-widest">Biblioteca Pro</span>
                          <button onClick={() => setIsLibraryOpen(false)} className="text-zinc-500 hover:text-white transition-colors bg-zinc-800 hover:bg-zinc-700 rounded-full w-6 h-6 flex items-center justify-center">✕</button>
                      </div>
                      <div className="p-2 overflow-y-auto flex-1">
                          {isLoadingLibrary ? (
                              <div className="text-center text-zinc-400 text-xs py-6 animate-pulse font-bold">📡 Conectando al servidor...</div>
                          ) : libraryTracks.length === 0 ? (
                              <div className="text-center text-zinc-500 text-xs py-6">No hay pistas disponibles.</div>
                          ) : (
                              libraryTracks.map((pista, idx) => (
                                  <div key={idx} onClick={() => loadTrackFromLibrary(pista)} className="p-3 hover:bg-zinc-800 cursor-pointer rounded-lg mb-1 flex items-center justify-between group transition-colors border border-transparent hover:border-zinc-700">
                                      <span className="text-xs font-bold text-zinc-300 group-hover:text-fuchsia-300 truncate pr-2">{pista.replace('.mp3', '').toUpperCase()}</span>
                                      <span className="text-[10px] font-black uppercase tracking-wider bg-fuchsia-600/20 text-fuchsia-400 border border-fuchsia-500/30 px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">Usar</span>
                                  </div>
                              ))
                          )}
                      </div>
                  </div>
              )}
          </div>

          <button onClick={() => sfxInputRef.current?.click()} className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded font-bold transition-all text-sm">
             <Zap className="w-4 h-4" /> SFX
          </button>

          <input type="file" accept="audio/*" multiple onChange={(e) => handleFileUpload(e, 'voice')} className="hidden" ref={voiceInputRef} />
          <input type="file" accept="audio/*" multiple onChange={(e) => handleFileUpload(e, 'music')} className="hidden" ref={musicInputRef} />
          <input type="file" accept="audio/*" multiple onChange={(e) => handleFileUpload(e, 'sfx')} className="hidden" ref={sfxInputRef} />
          
          <div className="w-px h-8 bg-zinc-700 mx-2 hidden md:block"></div>
          
          <button onClick={exportProjectJSON} className="flex items-center gap-2 bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded font-bold transition-all text-sm">
             <FileJson className="w-4 h-4" /> JSON
          </button>

          <div className="flex gap-2 bg-white rounded overflow-hidden shadow-xl p-1">
              <button onClick={() => exportMaster('wav')} disabled={clips.length === 0 || isProcessing} className="flex items-center gap-2 text-zinc-900 hover:bg-zinc-200 px-4 py-1.5 rounded font-bold transition-all text-sm disabled:opacity-50">
                {isProcessing ? 'Renderizando...' : <span className="flex items-center gap-1"><Download className="w-4 h-4" /> WAV</span>}
              </button>
              <div className="w-px bg-zinc-300"></div>
              <button onClick={() => exportMaster('mp3')} disabled={clips.length === 0 || isProcessing} className="flex items-center gap-2 text-zinc-900 hover:bg-zinc-200 px-4 py-1.5 rounded font-bold transition-all text-sm disabled:opacity-50">
                {isProcessing ? 'Renderizando...' : <span className="flex items-center gap-1"><FileAudio className="w-4 h-4 text-emerald-600" /> MP3</span>}
              </button>
          </div>
        </div>
      </header>

      
      {/* --- PANEL DE ESTILOS GLOBALES --- */}
      {clips.length > 0 && (
         <div className="bg-zinc-900 border border-emerald-500/30 rounded-xl p-4 shadow-[0_0_20px_rgba(16,185,129,0.1)] flex items-center justify-between animate-fade-in">
             <div className="flex items-center gap-3">
                 <Wand2 className="w-6 h-6 text-emerald-400" />
                 <div>
                     <h3 className="text-sm font-bold text-white uppercase tracking-widest">Estilos de Producción Globales</h3>
                     <p className="text-[10px] text-zinc-400">Transforma la vibra de todo el anuncio al instante (Filtros post-grabación).</p>
                 </div>
             </div>
             <div className="flex gap-2">
                 <button onClick={() => applyGlobalStyle('classic')} className={`px-4 py-2 rounded font-bold text-xs uppercase tracking-wider transition-all border ${activeGlobalStyle === 'classic' ? 'bg-zinc-200 text-zinc-900 border-white' : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700'}`}>
                     🎙️ Clásico (Limpio)
                 </button>
                 <button onClick={() => applyGlobalStyle('promo')} className={`px-4 py-2 rounded font-bold text-xs uppercase tracking-wider transition-all border ${activeGlobalStyle === 'promo' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500' : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700'}`}>
                     💥 Promo (Cierre Épico)
                 </button>
                 <button onClick={() => applyGlobalStyle('dj')} className={`px-4 py-2 rounded font-bold text-xs uppercase tracking-wider transition-all border ${activeGlobalStyle === 'dj' ? 'bg-amber-500/20 text-amber-400 border-amber-500' : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700'}`}>
                     🎧 DJ (Flanger / Coro)
                 </button>
                 <button onClick={() => applyGlobalStyle('urbano')} className={`px-4 py-2 rounded font-bold text-xs uppercase tracking-wider transition-all border ${activeGlobalStyle === 'urbano' ? 'bg-purple-500/20 text-purple-400 border-purple-500' : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700'}`}>
                     🏙️ Urbano (Teléfono / Coro)
                 </button>
             </div>
         </div>
      )}

      {/* Editor Principal */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl flex flex-col relative overflow-hidden flex-1 max-h-[60vh] shrink-0 min-h-[400px]">
        <div className="flex flex-wrap justify-between items-center p-3 border-b border-zinc-800 bg-zinc-950 gap-4">
            <div className="flex gap-2 items-center">
              <button onClick={handleCopy} disabled={selectedClipIds.length === 0} className="btn-tool text-cyan-400" title="Copiar (Ctrl+C)"><Copy className="w-4 h-4" /></button>
              <button onClick={handlePaste} disabled={clipboard.length === 0} className="btn-tool text-cyan-400" title="Pegar (Ctrl+V)"><ClipboardPaste className="w-4 h-4" /></button>
              <div className="w-px h-6 bg-zinc-800 mx-1"></div>

              <button onClick={handleSplit} disabled={selectedClipIds.length === 0 || isPlaying} className="btn-tool text-emerald-400" title="Cortar clip (S)"><Scissors className="w-4 h-4" /></button>
              <button onClick={handleDeleteClip} disabled={selectedClipIds.length === 0 || isPlaying} className="btn-tool text-red-400" title="Borrar (Supr)"><Trash2 className="w-4 h-4" /></button>
              <div className="w-px h-6 bg-zinc-800 mx-1"></div>
              <button onClick={handleUndo} disabled={history.length === 0 || isPlaying} className="btn-tool text-zinc-400"><Undo className="w-4 h-4" /></button>
              <div className="w-px h-6 bg-zinc-800 mx-1"></div>

              <button onClick={handleRemoveSilence} disabled={selectedClipIds.length === 0 || isPlaying} className="btn-tool text-purple-400" title="Eliminar silencios">
                 {isProcessing ? 'Procesando...' : <span className="flex items-center gap-1"><Zap className="w-4 h-4" /> Matar Silencios</span>}
              </button>

              <div className="w-px h-6 bg-zinc-800 mx-1"></div>
              {/* Botón de Modo Automatización */}
              <button 
                  onClick={() => setIsAutomationMode(!isAutomationMode)} 
                  className={`btn-tool ${isAutomationMode ? 'bg-amber-500/20 text-amber-400 border-amber-500' : 'text-zinc-400'}`} 
                  title="Modo Automatización (A)"
              >
                  <Activity className="w-4 h-4" /> Envelopes
              </button>

              <div className="w-px h-6 bg-zinc-800 mx-1"></div>
              <div className="flex items-center gap-2 bg-zinc-900 px-3 py-1 rounded-lg border border-zinc-800">
                <ZoomOut className="w-4 h-4 text-zinc-400" />
                <input type="range" min="0.5" max="6" step="0.1" value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} className="w-24 h-1 bg-zinc-700 rounded appearance-none cursor-pointer accent-white" />
                <ZoomIn className="w-4 h-4 text-zinc-400" />
              </div>
            </div>

            <div className="flex items-center gap-4">
               <label className={`flex items-center gap-2 cursor-pointer transition-all px-3 py-1.5 rounded-lg border ${autoDucking ? 'bg-emerald-900/30 border-emerald-500/50 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.2)]' : 'bg-zinc-800/50 border-zinc-700 text-zinc-400'}`}>
                 <Sparkles className="w-4 h-4" />
                 <span className="text-xs font-bold uppercase tracking-wider">Auto-Ducking Música</span>
                 <input type="checkbox" checked={autoDucking} onChange={() => setAutoDucking(!autoDucking)} className="sr-only" />
               </label>

               <div className={`flex items-center gap-2 bg-zinc-800/50 border border-zinc-700 px-3 py-1.5 rounded-lg transition-opacity ${primaryClip ? 'opacity-100' : 'opacity-30 pointer-events-none'}`}>
                 <Settings2 className="w-4 h-4 text-emerald-400" />
                 <span className="text-xs font-bold text-zinc-300 mr-2">Vol. Grupo ({selectedClipIds.length}):</span>
                 <input type="range" min="0" max="1.5" step="0.05" value={primaryClip ? primaryClip.volume : 1} onChange={(e) => updateClipVolume(parseFloat(e.target.value))} className="w-20 h-1 bg-zinc-900 rounded appearance-none cursor-pointer accent-emerald-500" />
                 <span className="text-xs font-mono font-bold text-emerald-400 w-8 text-right">{primaryClip ? Math.round(primaryClip.volume * 100) : 100}%</span>
               </div>
            </div>
        </div>

        {/* --- CONTENEDOR CENTRAL DE SCROLL SINCRONIZADO --- */}
        <div ref={scrollContainerRef} className="flex flex-1 bg-[#09090b] overflow-auto relative custom-scrollbar min-h-0">
            
            {/* Panel Izquierdo: Pistas (Fijo en Scroll Horizontal) */}
            <div className="w-48 shrink-0 bg-zinc-950 border-r border-zinc-800 flex flex-col z-40 sticky left-0 shadow-[5px_0_15px_rgba(0,0,0,0.5)]">
               
               <div className="h-6 border-b border-zinc-800 bg-zinc-900 flex items-center px-2 sticky top-0 z-50">
                 <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">Pistas</span>
               </div>
               
               {tracks.map((track, index) => (
                  <div key={track.id} 
                       draggable={draggableTrackId === track.id}
                       onDragStart={(e) => {
                           setDraggedTrackIdx(index);
                           e.dataTransfer.effectAllowed = 'move';
                       }}
                       onDragOver={(e) => { e.preventDefault(); setDragOverTrackIdx(index); }}
                       onDragLeave={() => setDragOverTrackIdx(null)}
                       onDrop={(e) => handleTrackDrop(e, index)}
                       onDragEnd={() => { setDraggedTrackIdx(null); setDragOverTrackIdx(null); setDraggableTrackId(null); }}
                       className={`h-[104px] shrink-0 border-b p-2 flex flex-col justify-between relative transition-all duration-200
                          ${draggedTrackIdx === index ? 'opacity-30 bg-zinc-800 border-zinc-800' : 'bg-zinc-900/50 border-zinc-800'}
                          ${dragOverTrackIdx === index ? (draggedTrackIdx < index ? 'border-b-2 border-b-emerald-500' : 'border-t-2 border-t-emerald-500') : ''}
                       `}>
                    <canvas ref={el => refs.current.trackMeterCanvases[track.id] = el} width="4" height="88" className="absolute right-1 top-2 bg-black rounded overflow-hidden shadow-inner" />
                    <div className="flex justify-between items-start pr-4">
                       <div className="flex items-center gap-1 overflow-hidden">
                         <div 
                            className="cursor-grab text-zinc-600 hover:text-white mr-1 flex items-center justify-center h-4 w-4 rounded active:cursor-grabbing hover:bg-zinc-700 transition-colors"
                            onMouseEnter={() => setDraggableTrackId(track.id)}
                            onMouseLeave={() => setDraggableTrackId(null)}
                            title="Arrastrar para reordenar canal"
                         >
                            <GripVertical className="w-3 h-3" />
                         </div>
                         {track.type === 'voice' && <Mic className="w-3 h-3 text-emerald-500 shrink-0" />}
                         {track.type === 'music' && <Music className="w-3 h-3 text-sky-500 shrink-0" />}
                         {track.type === 'sfx' && <Zap className="w-3 h-3 text-amber-500 shrink-0" />}
                         <span className="text-xs font-bold truncate text-zinc-300">{track.name}</span>
                       </div>
                       <button onClick={() => deleteTrack(track.id)} className="text-zinc-600 hover:text-red-400 ml-1 shrink-0 transition-colors"><Trash2 className="w-3 h-3" /></button>
                    </div>
                    <div className="flex gap-2 my-1 pr-4">
                       <button onClick={() => updateTrackProp(track.id, { muted: !track.muted })} className={`flex-1 text-[10px] font-bold rounded py-1 ${track.muted ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>M</button>
                       <button onClick={() => updateTrackProp(track.id, { solo: !track.solo })} className={`flex-1 text-[10px] font-bold rounded py-1 ${track.solo ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/50' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>S</button>
                    </div>
                    <div className="flex items-center gap-2 bg-zinc-950 p-1 rounded border border-zinc-800 pr-4 mt-auto mb-1">
                       <Volume2 className="w-3 h-3 text-zinc-500" />
                       <input type="range" min="0" max="2" step="0.05" value={track.volume} onChange={(e) => updateTrackProp(track.id, { volume: parseFloat(e.target.value) })} className="w-full h-1 bg-zinc-700 rounded appearance-none cursor-pointer" style={{accentColor: track.color}} />
                    </div>
                  </div>
               ))}
               
               {/* --- INDICADOR VISUAL: CABECERA DE LA NUEVA PISTA --- */}
               {dragState && dragState.type === 'move' && (
                  <div className="h-[104px] shrink-0 border-b border-dashed border-emerald-500/40 bg-emerald-950/10 flex flex-col justify-center items-center transition-all duration-300">
                      <Sparkles className="w-4 h-4 text-emerald-500/50 mb-1 animate-pulse" />
                      <span className="text-[8px] text-emerald-500/50 font-bold uppercase text-center px-2 tracking-widest">
                          Pista Automática
                      </span>
                  </div>
               )}

               <div className="flex-1 shrink-0 p-3 flex flex-col gap-2 justify-end bg-zinc-900/30 border-t border-zinc-800/50 mt-2 pb-6 min-h-[120px]">
                 <button onClick={() => addEmptyTrack('voice')} className="flex items-center justify-center gap-1 bg-emerald-900/20 border border-emerald-500/30 hover:bg-emerald-800/40 text-emerald-400 py-2 rounded text-[10px] uppercase font-bold transition-all"><Plus className="w-3 h-3"/> + Pista de Voz</button>
                 <button onClick={() => addEmptyTrack('music')} className="flex items-center justify-center gap-1 bg-sky-900/20 border border-sky-500/30 hover:bg-sky-800/40 text-sky-400 py-2 rounded text-[10px] uppercase font-bold transition-all"><Plus className="w-3 h-3"/> + Pista de Música</button>
                 <button onClick={() => addEmptyTrack('sfx')} className="flex items-center justify-center gap-1 bg-amber-900/20 border border-amber-500/30 hover:bg-amber-800/40 text-amber-400 py-2 rounded text-[10px] uppercase font-bold transition-all"><Plus className="w-3 h-3"/> + Pista de SFX</button>
               </div>
            </div>

            {/* Panel Derecho: Línea de Tiempo */}
            <div className="flex-1 relative timeline-bg select-none min-h-max" onMouseDown={handleTimelineMouseDown} onTouchStart={handleTimelineMouseDown}>
               <div ref={innerContainerRef} className="relative min-h-full" style={{ width: `${timelineWidthPx}px` }}>
                  
                  <div className="time-ruler h-6 border-b border-zinc-800 bg-zinc-900/80 sticky top-0 z-30 flex items-center overflow-hidden cursor-ew-resize">
                     {Array.from({length: Math.ceil(globalDuration)}).map((_, i) => (
                        i % (zoom < 1 ? 10 : (zoom > 3 ? 1 : 5)) === 0 ? (
                          <div key={i} className="absolute text-[9px] font-mono text-zinc-500 border-l border-zinc-700 pl-1" style={{ left: `${i * BASE_PPS * zoom}px` }}>
                             {Math.floor(i / 60)}:{Math.floor(i % 60).toString().padStart(2, '0')}
                          </div>
                        ) : null
                     ))}
                  </div>

                  {snapPosition !== null && (
                      <div className="absolute top-0 bottom-0 w-[1px] bg-emerald-500 z-50 pointer-events-none shadow-[0_0_5px_rgba(16,185,129,0.8)]" style={{ left: `${snapPosition * BASE_PPS * zoom}px` }}></div>
                  )}

                  {tracks.map((track, index) => (
                    <div key={track.id} data-trackid={track.id} 
                         className={`track-dropzone shrink-0 h-[104px] border-b relative transition-all duration-200
                            ${draggedTrackIdx === index ? 'opacity-30 bg-zinc-950/80 border-zinc-800/50' : 'bg-zinc-950/30 border-zinc-800/50'}
                            ${dragOverTrackIdx === index ? (draggedTrackIdx < index ? 'border-b-2 border-b-emerald-500' : 'border-t-2 border-t-emerald-500') : ''}
                         `}>
                         {clips.filter(c => c.trackId === track.id).map(clip => {
                             const leftPx = clip.startTime * BASE_PPS * zoom;
                             const widthPx = clip.duration * BASE_PPS * zoom;
                             const isSelected = selectedClipIds.includes(clip.id);
                             const isDragging = dragState && selectedClipIds.includes(clip.id) && dragState.type !== 'moveNode' && dragState.type !== 'pan'; 

                             return (
                                 <div key={clip.id} 
                                     id={`clip-${clip.id}`}
                                     onMouseDown={(e) => handleClipMouseDown(e, clip)} 
                                     onTouchStart={(e) => handleClipMouseDown(e, clip)}
                                     className={`nle-clip absolute top-1 bottom-1 rounded-md overflow-hidden transition-shadow flex flex-col
                                        ${isSelected ? 'ring-2 ring-white z-30 shadow-[0_0_20px_rgba(255,255,255,0.2)]' : 'border border-zinc-800/80 z-20'}
                                        ${isDragging ? 'opacity-70 cursor-grabbing' : 'opacity-100'} 
                                        ${!isAutomationMode ? 'cursor-grab' : 'cursor-crosshair'}
                                     `}
                                     style={{ left: `${leftPx}px`, width: `${widthPx}px`, backgroundColor: `${track.color}15` }}>
                                    
                                    <div className="absolute top-0 left-0 w-full h-full pointer-events-none">
                                        {clip.fadeIn > 0 && <div className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-black/80 to-transparent z-10" style={{width: `${clip.fadeIn * BASE_PPS * zoom}px`}}></div>}
                                        {clip.fadeOut > 0 && <div className="absolute top-0 bottom-0 right-0 bg-gradient-to-l from-black/80 to-transparent z-10" style={{width: `${clip.fadeOut * BASE_PPS * zoom}px`}}></div>}
                                        <ClipWaveform clip={clip} color={track.color} />
                                    </div>

                                    {!isAutomationMode && (
                                        <>
                                            <div className="fade-in-handle absolute top-0 left-0 w-4 h-4 cursor-ew-resize z-40 flex items-start hover:scale-125 transition-transform"><div className="w-0 h-0 border-t-[8px] border-r-[8px] border-t-white border-r-transparent shadow-md"></div></div>
                                            <div className="fade-out-handle absolute top-0 right-0 w-4 h-4 cursor-ew-resize z-40 flex items-start justify-end hover:scale-125 transition-transform"><div className="w-0 h-0 border-t-[8px] border-l-[8px] border-t-white border-l-transparent shadow-md"></div></div>
                                            <div className="absolute top-4 bottom-0 left-0 w-2 hover:bg-white/30 cursor-ew-resize z-40 transition-colors" title="Arrastrar Borde (Trim)"></div>
                                            <div className="absolute top-4 bottom-0 right-0 w-2 hover:bg-white/30 cursor-ew-resize z-40 transition-colors" title="Arrastrar Borde (Trim)"></div>
                                        </>
                                    )}

                                    {isAutomationMode && (
                                        <div className="absolute inset-0 z-50 pointer-events-auto" onMouseDown={(e) => handleAddAutomationNode(e, clip)}>
                                            <svg className="w-full h-full pointer-events-none">
                                                {clip.automation && clip.automation.length > 0 ? (
                                                    <polyline 
                                                        fill="none" stroke="#f59e0b" strokeWidth="2"
                                                        points={`0,${(1-clip.volume) * 100}% ${clip.automation.map(n => `${n.timeRatio * widthPx},${(1-n.value) * 100}%`).join(' ')} ${widthPx},${(1-(clip.automation[clip.automation.length-1]?.value || clip.volume)) * 100}%`}
                                                    />
                                                ) : null}
                                            </svg>
                                            {clip.automation?.map(node => (
                                                <div 
                                                    key={node.id} 
                                                    onMouseDown={(e) => handleAutomationNodeMouseDown(e, clip, node.id)}
                                                    className="absolute w-3 h-3 bg-amber-500 rounded-full border border-white transform -translate-x-1.5 -translate-y-1.5 cursor-move pointer-events-auto shadow-md hover:scale-125 transition-transform"
                                                    style={{ left: `${node.timeRatio * 100}%`, top: `${(1 - node.value) * 100}%` }}
                                                    title="Click derecho para borrar"
                                                ></div>
                                            ))}
                                        </div>
                                    )}

                                    <div className="flex justify-between items-center px-1 text-[9px] font-bold text-white bg-black/60 truncate z-20 pointer-events-none">
                                        <span>{clip.name}</span>
                                    </div>
                                 </div>
                             );
                         })}
                    </div>
                  ))}

                  {/* --- INDICADOR VISUAL: ÁREA DE SOLTADO (DROPZONE) --- */}
                  {dragState && dragState.type === 'move' && (
                     <div data-trackid="new-track" className="track-dropzone shrink-0 h-[104px] border-b border-dashed border-emerald-500/40 bg-emerald-950/5 relative flex items-center justify-center transition-all duration-300">
                         <span className="text-emerald-500/30 font-bold uppercase tracking-widest text-xs pointer-events-none">
                             + Arrastra aquí para separar a un nuevo canal
                         </span>
                     </div>
                  )}

                  {marquee && (
                      <div className="absolute border border-emerald-500 bg-emerald-500/20 z-50 pointer-events-none"
                           style={{ left: Math.min(marquee.startX, marquee.currentX), top: Math.min(marquee.startY, marquee.currentY), width: Math.abs(marquee.currentX - marquee.startX), height: Math.abs(marquee.currentY - marquee.startY) }}
                      />
                  )}

                  <div ref={playheadRef} className="absolute top-0 bottom-0 w-[2px] bg-red-500 shadow-[0_0_10px_red] z-50 pointer-events-none" style={{ left: `${refs.current.currentTime * BASE_PPS * zoom}px` }}>
                      <div className="absolute -top-1 -left-2 w-0 h-0 border-l-[8px] border-r-[8px] border-t-[10px] border-l-transparent border-r-transparent border-t-red-500 pointer-events-auto cursor-ew-resize playhead-handle" onMouseDown={handleTimelineMouseDown} onTouchStart={handleTimelineMouseDown}></div>
                  </div>
               </div>
            </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 relative shrink-0">
          <div className="lg:col-span-4 flex flex-col gap-6">
             <div className="flex items-center justify-center gap-6 bg-zinc-900 p-6 rounded-xl border border-zinc-800 shadow-xl relative z-40">
                 <button onClick={stopAudio} disabled={tracks.length === 0} className="p-3 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-all disabled:opacity-30">
                   <Square className="w-6 h-6 fill-current" />
                 </button>
                 <button onClick={isPlaying ? pauseAudio : playAudio} disabled={tracks.length === 0} className="px-10 py-4 bg-emerald-500 text-zinc-900 rounded-xl hover:bg-emerald-400 active:scale-95 transition-all shadow-[0_0_20px_rgba(16,185,129,0.3)] disabled:opacity-30">
                   {isPlaying ? <Pause className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 fill-current ml-1" />}
                 </button>
                 <div ref={timeDisplayRef} className="text-2xl font-mono text-emerald-400 bg-black px-4 py-2 rounded-lg border border-zinc-800 w-32 text-center">0:00.00</div>
             </div>

             <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 shadow-xl flex-1 flex flex-col min-h-[150px]">
                <div className="flex items-center justify-between mb-3 border-b border-zinc-800 pb-2">
                   <div className="flex items-center gap-2">
                     <BarChart3 className="w-4 h-4 text-emerald-400" />
                     <h2 className="text-xs font-bold text-zinc-300 uppercase tracking-widest">RTA Master Output</h2>
                   </div>
                   <div className="flex items-center gap-2">
                       <span className="text-[10px] text-zinc-500 font-bold uppercase">Master</span>
                       <input type="range" min="0" max="2" step="0.05" value={masterGain} onChange={(e) => setMasterGain(parseFloat(e.target.value))} className="w-16 h-1 bg-zinc-700 rounded appearance-none cursor-pointer accent-red-500" />
                   </div>
               </div>
               <div className="flex-1 bg-black rounded border border-zinc-800 overflow-hidden relative min-h-[100px]">
                  <canvas ref={(el) => refs.current.analyserCanvas = el} width="300" height="150" className="absolute inset-0 w-full h-full" />
               </div>
             </div>
          </div>
          
          <div className="lg:col-span-8 bg-[#1c1c1e] border border-zinc-800 rounded-xl p-6 shadow-2xl flex flex-col max-h-[600px] overflow-y-auto relative">
             {selectedClipIds.length === 0 && (
                <div className="absolute inset-0 bg-zinc-950/60 backdrop-blur-[2px] z-50 flex items-center justify-center pointer-events-auto rounded-xl">
                   <div className="bg-zinc-900 border border-zinc-700 px-6 py-4 rounded-xl shadow-2xl text-center">
                      <Sliders className="w-8 h-8 text-zinc-500 mx-auto mb-2" />
                      <h3 className="text-white font-bold tracking-widest uppercase">Efectos por Grupo o Clip</h3>
                      <p className="text-xs text-zinc-400 mt-1">Haz clic en uno o más clips (Ctrl/Shift + Click) para modificar sus efectos.</p>
                   </div>
                </div>
            )}

            <div className="flex items-center justify-between mb-6 border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                <Settings2 className="w-5 h-5 text-emerald-400" />
                <h2 className="text-sm font-bold text-white uppercase tracking-widest">
                  FX DEL GRUPO SELECCIONADO <span className="text-zinc-500 font-normal">({selectedClipIds.length > 1 ? selectedClipIds.length + ' clips' : primaryClip?.name})</span>
                </h2>
              </div>
            </div>
            
            <div className="mb-6">
              <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">Plantillas Rápidas para Selección</div>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                <button onClick={() => applyPreset('neutro')} className={`flex flex-col items-center gap-1 py-2 rounded border transition-all ${activePreset === 'neutro' ? 'bg-zinc-800 border-zinc-500 text-white' : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-600'}`}>
                  <span className="text-lg">🎙️</span><span className="text-[9px] font-bold uppercase">Limpio</span>
                </button>
                <button onClick={() => applyPreset('radio')} className={`flex flex-col items-center gap-1 py-2 rounded border transition-all ${activePreset === 'radio' ? 'bg-sky-900/30 border-sky-500/50 text-sky-400' : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-600'}`}>
                  <span className="text-lg">📻</span><span className="text-[9px] font-bold uppercase">Locutor FM</span>
                </button>
                <button onClick={() => applyPreset('perifoneo')} className={`flex flex-col items-center gap-1 py-2 rounded border transition-all ${activePreset === 'perifoneo' ? 'bg-amber-900/30 border-amber-500/50 text-amber-400' : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-600'}`}>
                  <span className="text-lg">📢</span><span className="text-[9px] font-bold uppercase">Perifoneo</span>
                </button>
                <button onClick={() => applyPreset('promo')} className={`flex flex-col items-center gap-1 py-2 rounded border transition-all ${activePreset === 'promo' ? 'bg-purple-900/30 border-purple-500/50 text-purple-400' : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-600'}`}>
                  <span className="text-lg">💥</span><span className="text-[9px] font-bold uppercase">Promo (Eco)</span>
                </button>
                <button onClick={() => applyPreset('telefono')} className={`flex flex-col items-center gap-1 py-2 rounded border transition-all ${activePreset === 'telefono' ? 'bg-emerald-900/30 border-emerald-500/50 text-emerald-400' : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-600'}`}>
                  <span className="text-lg">☎️</span><span className="text-[9px] font-bold uppercase">Teléfono</span>
                </button>
              </div>
            </div>

            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5 px-2">
              <div className="flex flex-col gap-4">
                  <div className="border-b border-zinc-800 pb-2"><span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Color & Dinámica</span></div>
                  <HorizontalSlider label="COLOR (SOUNDGOODIZER)" value={activeFx?.soundgoodizer || 0} min={0} max={100} step={1} unit="%" onChange={(v) => updateClipFx('soundgoodizer', v)} color="emerald" />
                  <HorizontalSlider label="COMPRESIÓN" value={activeFx?.compresion || 0} min={0} max={100} step={1} unit="%" onChange={(v) => updateClipFx('compresion', v)} color="emerald" />
                  <HorizontalSlider label="DE-ESSER (Matar Sibilancia)" value={activeFx?.deEsser || 0} min={0} max={100} step={1} unit="%" onChange={(v) => updateClipFx('deEsser', v)} color="sky" />
                  
                  <div className="border-b border-zinc-800 pb-2 mt-2"><span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Ecualizador 5-Bandas</span></div>
                  <HorizontalSlider label="SUB GRAVES" value={activeFx?.eq.sub || 0} min={-12} max={12} step={0.5} unit="dB" onChange={(v) => updateClipFx('eq', v, 'sub')} color="emerald" />
                  <HorizontalSlider label="BAJOS" value={activeFx?.eq.low || 0} min={-12} max={12} step={0.5} unit="dB" onChange={(v) => updateClipFx('eq', v, 'low')} color="emerald" />
                  <HorizontalSlider label="MEDIOS" value={activeFx?.eq.mid || 0} min={-12} max={12} step={0.5} unit="dB" onChange={(v) => updateClipFx('eq', v, 'mid')} color="emerald" />
                  <HorizontalSlider label="PRESENCIA" value={activeFx?.eq.highMid || 0} min={-12} max={12} step={0.5} unit="dB" onChange={(v) => updateClipFx('eq', v, 'highMid')} color="emerald" />
                  <HorizontalSlider label="AGUDOS" value={activeFx?.eq.high || 0} min={-12} max={12} step={0.5} unit="dB" onChange={(v) => updateClipFx('eq', v, 'high')} color="emerald" />
              </div>

              <div className="flex flex-col gap-4">
                  <div className="border-b border-zinc-800 pb-2"><span className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Modulación y DJ FX</span></div>
                  <HorizontalSlider label="CHORUS (Voz Robótica/Doble)" value={activeFx?.chorus || 0} min={0} max={100} step={1} unit="%" onChange={(v) => updateClipFx('chorus', v)} color="amber" />
                  <HorizontalSlider label="FLANGER (Sonido Jet)" value={activeFx?.flanger || 0} min={0} max={100} step={1} unit="%" onChange={(v) => updateClipFx('flanger', v)} color="amber" />
                  
                  <div className="border-b border-zinc-800 pb-2 mt-2"><span className="text-[10px] font-bold text-purple-400 uppercase tracking-widest">Espacio (Delay)</span></div>
                  <HorizontalSlider label="ECO / REVERB" value={activeFx?.ecoReverb || 0} min={0} max={100} step={1} unit="%" onChange={(v) => updateClipFx('ecoReverb', v)} color="purple" />
              </div>
            </div>
          </div>
      </div>

      <style dangerouslySetInnerHTML={{__html: `
        .btn-tool {
          display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.6rem;
          background-color: #27272a; border-radius: 0.4rem; font-size: 0.75rem;
          font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; transition: all 0.2s;
          border: 1px solid #3f3f46;
        }
        .btn-tool:not(:disabled):hover { background-color: #3f3f46; color: white; border-color: #52525b; }
        .btn-tool:disabled { opacity: 0.3; cursor: not-allowed; }
        
        input[type=range].custom-slider {
          -webkit-appearance: none; width: 100%; background: transparent; height: 16px;
        }
        input[type=range].custom-slider::-webkit-slider-runnable-track {
          width: 100%; height: 4px; cursor: pointer; background: #3f3f46; border-radius: 2px;
        }
        input[type=range].custom-slider::-webkit-slider-thumb {
          height: 14px; width: 14px; border-radius: 50%; cursor: pointer; -webkit-appearance: none; margin-top: -5px; box-shadow: 0 0 5px rgba(0,0,0,0.5);
        }

        /* Barras de scroll elegantes personalizadas para el contenedor NLE */
        .custom-scrollbar::-webkit-scrollbar { width: 12px; height: 12px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #09090b; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #27272a; border-radius: 6px; border: 3px solid #09090b; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #3f3f46; }
      `}} />
    </div>
  );
}

const ClipWaveform = React.memo(({ clip, color }) => {
    const canvasRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !clip.buffer) return;
        const width = canvas.clientWidth || 300; 
        const height = canvas.clientHeight || 50;
        const dpr = window.devicePixelRatio || 1;
        
        canvas.width = width * dpr; canvas.height = height * dpr;
        const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

        const data = clip.buffer.getChannelData(0); 
        
        const startSample = Math.floor(clip.offset * clip.buffer.sampleRate);
        const endSample = Math.floor((clip.offset + clip.duration) * clip.buffer.sampleRate);
        const sliceLength = endSample - startSample;
        
        const step = Math.ceil(sliceLength / width); 
        const amp = height / 2;

        ctx.clearRect(0, 0, width, height); ctx.fillStyle = color;

        for (let i = 0; i < width; i++) {
            let min = 1.0; let max = -1.0;
            for (let j = 0; j < step; j += Math.max(1, Math.floor(step/10))) { 
                const sampleIndex = startSample + (i * step) + j;
                if (sampleIndex < data.length) {
                    const datum = data[sampleIndex];
                    if (datum < min) min = datum; if (datum > max) max = datum;
                }
            }
            ctx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
        }
    }, [clip.buffer, color, clip.offset, clip.duration]); 

    return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none opacity-40" />;
});

// COMPONENTE DE SLIDERS
function HorizontalSlider({ label, value, min, max, step, unit, display, onChange, color="emerald" }) {
  const accentColors = { emerald: 'text-emerald-400', sky: 'text-sky-400', amber: 'text-amber-500', purple: 'text-purple-400' };
  const thumbColors = { emerald: '#10B981', sky: '#38bdf8', amber: '#f59e0b', purple: '#c084fc' };
  
  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex justify-between text-[11px] font-bold uppercase tracking-wider text-zinc-400">
        <span>{label}</span>
      </div>
      <div className="flex items-center gap-4 w-full relative">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} 
               className="custom-slider flex-1" style={{ '--thumb-color': thumbColors[color] }} />
        <span className={`font-mono w-10 text-right text-[10px] ${accentColors[color]}`}>{display ? display(value) : Number(value).toFixed(1)}{unit}</span>
        <style dangerouslySetInnerHTML={{__html: `
            input[type=range].custom-slider::-webkit-slider-thumb { background: var(--thumb-color, #10B981); }
        `}}/>
      </div>
    </div>
  );
}
