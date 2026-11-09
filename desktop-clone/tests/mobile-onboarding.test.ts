import { describe,it,expect,beforeAll } from 'vitest';
import { prepareZXingModule } from 'zxing-wasm/reader';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes,randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { installLink,installDesktop } from '../src/renderer/lib/mobile-install';
import { cameraCrop,decodeQrPixels } from '../src/renderer/lib/mobile-qr';
const {PNG}=createRequire(import.meta.url)('pngjs') as {PNG:{sync:{read:(bytes:Buffer)=>{width:number;height:number;data:Buffer}}}};
beforeAll(()=>{prepareZXingModule({overrides:{wasmBinary:readFileSync(createRequire(import.meta.url).resolve('zxing-wasm/reader/zxing_reader.wasm'))}});});

describe('mobile installation and optical pairing',()=>{
  it('carries only a public computer hint between browsers, never pairing secrets',()=>{
    const desktop=randomBytes(32).toString('hex'),link=installLink('https://mobile.tinygpt.org',desktop);
    expect(new URL(link).searchParams.size).toBe(1); expect(new URL(link).hash).toBe('');expect(installDesktop(link)).toBe(desktop);
    expect(installLink('https://mobile.tinygpt.org','invalid')).toBe('https://mobile.tinygpt.org/');expect(installDesktop('https://mobile.tinygpt.org/?setup=invalid')).toBeUndefined();
  });
  it('decodes varying encrypted QR payloads at compact desktop sizes',async()=>{
    for(let i=0;i<8;i++) {
      const value='https://mobile.tinygpt.org/#'+new URLSearchParams({desktop:randomBytes(32).toString('hex'),invitation:randomUUID(),token:randomBytes(32).toString('hex'),key:randomBytes(32).toString('hex'),v:'2'});
      for(const width of [256,288,340]) {
        const png=PNG.sync.read(await QRCode.toBuffer(value,{width,margin:4,errorCorrectionLevel:'M'}));
        expect(await decodeQrPixels(new Uint8ClampedArray(png.data),png.width,png.height)).toBe(value);
        if(width===288) {
          const rotated=new Uint8ClampedArray(png.data.length);
          for(let y=0;y<png.height;y++)for(let x=0;x<png.width;x++)for(let c=0;c<4;c++)rotated[(x*png.height+png.height-1-y)*4+c]=c===3?255:255-png.data[(y*png.width+x)*4+c];
          expect(await decodeQrPixels(rotated,png.height,png.width)).toBe(value);
        }
      }
    }
  });
  it('crops landscape and portrait camera frames to the visible square without distorting the code',()=>{
    expect(cameraCrop(1920,1080)).toEqual({x:420,y:0,size:1080});expect(cameraCrop(1080,1920)).toEqual({x:0,y:420,size:1080});expect(cameraCrop(1280,720,.8)).toEqual({x:352,y:72,size:576});
  });
});
