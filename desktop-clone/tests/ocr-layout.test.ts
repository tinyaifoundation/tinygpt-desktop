import {it,expect} from 'vitest';
import {ocrWords,ocrColumns,regionText,numericOCRConflict} from '../src/core/ocr-layout';
it('separates interleaved columns by geometry without assigning a semantic plan',()=>{
  const rows:string[]=[];
  for(let line=0;line<9;line++)for(let column=0;column<4;column++)rows.push(['5','1','1','1',line+1,column+1,50+column*400,300+line*55,180,24,96,`Column${column}Line${line}`].join('\t'));
  const words=ocrWords(rows.join('\n')),regions=ocrColumns(words,1600,1000);
  expect(regions).toHaveLength(4);
  for(const [i,region] of regions.entries()){const text=regionText(region.words);expect(text).toContain(`Column${i}Line8`);expect(text).not.toContain(`Column${(i+1)%4}Line8`);}
  expect(ocrColumns(words.slice(0,4),1600,1000)).toEqual([]);
});
it('does not silently accept conflicting prices or counts from recovery',()=>{
  expect(numericOCRConflict('$30 per month, 4x usage','$ 3 0) per month, 4x usage')).toBe(true);
  expect(numericOCRConflict('4x usage $30/month','$30 per month 4x usage')).toBe(false);
  expect(ocrWords('5\t1\t1\t1\t1\t1\tNaN\t0\t20\t20\t90\tbad')).toEqual([]);
});
