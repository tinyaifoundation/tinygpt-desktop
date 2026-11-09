import { prepareZXingModule,readBarcodes } from 'zxing-wasm/reader';
import wasmURL from 'zxing-wasm/reader/zxing_reader.wasm?url';

// Bundle the reader with TinyGPT. Camera frames never leave this device or
// load a decoder from a third-party CDN.
prepareZXingModule({overrides:{locateFile:(path: string,prefix: string)=>path.endsWith('.wasm')?wasmURL:prefix+path}});
export function cameraCrop(width: number, height: number, fraction = 1) {
  const side = Math.floor(Math.min(width,height) * fraction);
  return { x: Math.floor((width-side)/2), y: Math.floor((height-side)/2), size: side };
}
export async function decodeQrPixels(pixels: Uint8ClampedArray, width: number, height: number): Promise<string | undefined> {
  const results=await readBarcodes({data:pixels,width,height} as ImageData,{formats:['QRCode'],tryHarder:true,tryInvert:true,tryRotate:true,maxNumberOfSymbols:1});
  return results[0]?.text;
}
