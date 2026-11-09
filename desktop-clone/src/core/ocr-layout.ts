export interface OCRWord { text:string; confidence:number; x:number; y:number; width:number; height:number; line:string }
export interface OCRRegion { x:number; y:number; width:number; height:number; words:OCRWord[] }
export function ocrWords(tsv:string):OCRWord[] {
  return tsv.split(/\r?\n/).slice(0,30000).flatMap(row=>{
    const c=row.split('\t'),text=c.slice(11).join('\t').trim();
    const [x,y,width,height,confidence]=c.slice(6,11).map(Number);
    return c[0]==='5'&&text&&[x,y,width,height,confidence].every(Number.isFinite)&&x>=0&&y>=0&&width>0&&height>0
      ?[{text,confidence,x,y,width,height,line:c.slice(1,5).join(':')}]:[];
  });
}
export function regionText(words:OCRWord[]) {
  const lines=new Map<string,OCRWord[]>();for(const word of words){const row=lines.get(word.line)??[];row.push(word);lines.set(word.line,row);}
  return [...lines.values()].sort((a,b)=>a[0].y-b[0].y).map(row=>row.sort((a,b)=>a.x-b.x).map(w=>w.text).join(' ')).join('\n');
}
/** Conservative whitespace columns, not a semantic table/card classifier. */
export function ocrColumns(words:OCRWord[],width:number,height:number):OCRRegion[] {
  if(words.length<30)return [];
  const body=words.filter(word=>word.y>=height*.35&&word.width<width*.4);
  if(body.length<24)return [];
  const bins=new Int32Array(512);for(const word of body)for(let i=Math.floor(word.x/width*512);i<=Math.min(511,Math.ceil((word.x+word.width)/width*512));i++)bins[i]++;
  const gaps:number[]=[];let start=-1;
  for(let i=35;i<478;i++){if(bins[i]<=1){if(start<0)start=i;}else if(start>=0){if(i-start>=6)gaps.push((i+start)/2/512*width);start=-1;}}
  const cuts=[0,...gaps,width];if(cuts.length<3||cuts.length>5)return [];
  const bodyGroups=cuts.slice(0,-1).map((left,i)=>body.filter(w=>w.x+w.width/2>=left&&w.x+w.width/2<cuts[i+1]));
  if(bodyGroups.some(group=>group.length<6||new Set(group.map(w=>w.line)).size<4))return [];
  const lines=new Map<string,OCRWord[]>();for(const word of words){const row=lines.get(word.line)??[];row.push(word);lines.set(word.line,row);}
  const first=[...lines.values()].filter(row=>new Set(row.map(w=>cuts.findIndex((left,i)=>i<cuts.length-1&&w.x+w.width/2>=left&&w.x+w.width/2<cuts[i+1]))).size>=Math.min(3,cuts.length-1)).sort((a,b)=>a[0].y-b[0].y)[0];
  const top=first?Math.max(0,Math.min(...first.map(w=>w.y))-12):0;
  return cuts.slice(0,-1).map((left,i)=>({x:Math.floor(left),y:top,width:Math.ceil(cuts[i+1])-Math.floor(left),height:height-top,words:words.filter(w=>w.y>=top&&w.x+w.width/2>=left&&w.x+w.width/2<cuts[i+1])}));
}
export const ocrConfidence=(words:OCRWord[])=>words.length?Math.round(words.reduce((sum,w)=>sum+w.confidence,0)/words.length):0;
export function numericOCRConflict(original:string,retry:string) {
  const numbers=(text:string)=>[...text.matchAll(/\d+(?:[.,]\d+)*/g)].map(m=>m[0]).sort().join('|');
  return numbers(original)!==numbers(retry);
}
