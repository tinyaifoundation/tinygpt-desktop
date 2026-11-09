import {z} from 'zod';
export const botShapes=['circle','pebble','squircle','capsule','triangle','diamond','hexagon','star','cloud','droplet','heart','ghost','cat','bear','bunny','amoeba','flower','clover','leaf','gem','bubble'] as const;
export const botExpressions=['neutral','attentive','focused','surprised','excited','happy','laughing','wink','angry','sad','worried','scared','suspicious','confused','curious','proud','smug','shy','unimpressed','sleepy','pleading','determined','tired','crosseyed','content','dreamy'] as const;
export const botDesignSchema=z.preprocess(value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const {roundness:_roundness,antenna:_antenna,...design}=value as Record<string,unknown>;
  return {...design,shape:design.shape==='square'?'squircle':design.shape==='teardrop'?'droplet':design.shape};
},z.object({name:z.string().trim().min(1).max(40),color:z.string().regex(/^#[\da-f]{6}$/i),shape:z.enum(botShapes),expression:z.enum(botExpressions).default('neutral')}).strict());
export type BotDesign=z.infer<typeof botDesignSchema>;
export const defaultBotDesign:BotDesign={name:'Your Bot',color:'#3b93f0',shape:'circle',expression:'neutral'};
export interface RemoteBotState {
  conversationId:string;name:string;design:BotDesign;snoozed:boolean;phase:'idle'|'preparing'|'ready'|'error';browser:boolean;
  watches:{id:string;title:string;enabled:boolean;nextRunAt:number|null}[];
}
