import { useEffect,useRef,useState } from 'react';
import { Devices } from '../icons';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { parsePairingLink } from '../lib/mobile-pairing';

export function ComputerScanner({ close,scan }: { close: () => void; scan: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null), photo = useRef<HTMLInputElement>(null), [camera,setCamera] = useState(true), [error,setError] = useState(''), [link,setLink] = useState(''), [paste,setPaste] = useState(false), [hint,setHint] = useState('Point at the code on your computer.');
  const scanRef = useRef(scan); scanRef.current = scan;
  function accept(text: string) {
    try { parsePairingLink(text); scanRef.current(text); return true; }
    catch { setError('Use a fresh code from TinyGPT on your computer.'); return false; }
  }
  useEffect(() => {
    if (!camera) return;
    let disposed = false, stream: MediaStream | undefined, timer: ReturnType<typeof setTimeout>;
    const stop = () => { stream?.getTracks().forEach(track => track.stop()); };
    const hidden = () => { if (document.visibilityState === 'hidden') { stop(); setCamera(false); } };
    const pageHide = () => { stop(); setCamera(false); };
    document.addEventListener('visibilitychange',hidden); window.addEventListener('pagehide',pageHide);
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' },width: { ideal: 1920 },height: { ideal: 1080 } },audio: false });
        if (disposed) { stop(); return; }
        const element = video.current; if (!element) { stop(); return; } element.srcObject = stream; await element.play();
        const { decodeQrPixels,cameraCrop } = await import('../lib/mobile-qr'); if (disposed) return;
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d',{ willReadFrequently: true })!;
        let frameNumber = 0; const started = Date.now();
        const frame = async () => {
          if (disposed) return;
          if (element.readyState >= 2 && element.videoWidth) {
            // Match object-fit: cover in the square preview, then alternate a
            // tighter crop. Never reduce the entire camera frame to 720px.
            const crop = cameraCrop(element.videoWidth,element.videoHeight,frameNumber++ % 2 ? .8 : 1);
            canvas.width = canvas.height = Math.min(crop.size,1280);
            context.imageSmoothingEnabled = false; context.drawImage(element,crop.x,crop.y,crop.size,crop.size,0,0,canvas.width,canvas.height);
            try {
              const pixels = context.getImageData(0,0,canvas.width,canvas.height), code = await decodeQrPixels(pixels.data,pixels.width,pixels.height);
              if(disposed)return;
              if (code && accept(code)) { stop(); disposed = true; return; }
            } catch { /* A missed frame must not silently stop the camera. */ }
            if (Date.now() - started > 7000) setHint('Move closer and keep the code inside the frame.');
          }
          timer = setTimeout(frame,160);
        }; void frame();
      } catch { if (!disposed) { stop(); setCamera(false); setError('Allow camera access, or use a photo or link.'); } }
    })();
    return () => { disposed = true; clearTimeout(timer); stop(); document.removeEventListener('visibilitychange',hidden); window.removeEventListener('pagehide',pageHide); };
  },[camera]);
  async function readPhoto(file?: File) {
    if (!file) return; setCamera(false); setError(''); const url = URL.createObjectURL(file);
    try {
      const image = new Image(); image.src = url; await image.decode();
      const {decodeQrPixels,cameraCrop} = await import('../lib/mobile-qr');
      const canvas=document.createElement('canvas'), context=canvas.getContext('2d',{willReadFrequently:true})!;
      for(const centered of [true,false]) {
        const crop=cameraCrop(image.naturalWidth,image.naturalHeight), width=centered?crop.size:image.naturalWidth,height=centered?crop.size:image.naturalHeight,scale=Math.min(1,1600/Math.max(width,height));
        canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
        context.drawImage(image,centered?crop.x:0,centered?crop.y:0,width,height,0,0,canvas.width,canvas.height);
        const pixels=context.getImageData(0,0,canvas.width,canvas.height),code=await decodeQrPixels(pixels.data,pixels.width,pixels.height);
        if(code && accept(code)) return;
      }
      setError('No TinyGPT code found. Try another photo.');
    } catch { setError('This photo could not be read. Try another photo or link.'); } finally { URL.revokeObjectURL(url); }
  }
  return <Dialog open change={open => { if (!open) close(); }} title="Connect a computer" className="mobile-scan-dialog">
    <p className="mobile-scan-caption" role="status">{hint}</p>
    <div className="mobile-camera-frame"><video ref={video} autoPlay muted playsInline aria-label="QR scanner" /><div className="mobile-camera-target" />{!camera && <Button variant="pill" onClick={() => { setError(''); setCamera(true); }}><Devices />Start camera</Button>}</div>
    {error && <p className="mobile-setup-error" role="alert">{error}</p>}
    <div className="mobile-scan-alternatives"><Button variant="ghost" onClick={()=>photo.current?.click()}>Use photo</Button><Button variant="ghost" aria-expanded={paste} onClick={()=>setPaste(value=>!value)}>Paste link</Button></div>
    <input ref={photo} hidden type="file" accept="image/*" aria-label="Choose QR photo" onChange={event=>{void readPhoto(event.currentTarget.files?.[0]);event.currentTarget.value='';}} />
    {paste && <form className="mobile-link-form" onSubmit={event=>{event.preventDefault();accept(link);}}><input className="control" aria-label="Pairing link" autoComplete="off" placeholder="Paste pairing link" value={link} onChange={event=>setLink(event.target.value)} /><Button variant="pill" disabled={!link.trim()}>Connect</Button></form>}
  </Dialog>;
}
