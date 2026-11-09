import {createECDH} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const configPath=new URL('../remote-relay/wrangler.jsonc',import.meta.url),config=JSON.parse(await readFile(configPath,'utf8'));
if(config.vars?.VAPID_PUBLIC_KEY&&!process.argv.includes('--rotate')){console.log('Existing Web Push keys preserved.');process.exit(0);}
const keys=createECDH('prime256v1');keys.generateKeys();
const child=spawn(process.execPath,[fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url)),'secret','put','VAPID_PRIVATE_KEY','--config',fileURLToPath(configPath)],{stdio:['pipe','pipe','pipe'],windowsHide:true});
let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(output)));});
// Pipe the private key directly into Cloudflare; never write it to disk or logs.
child.stdin.end(keys.getPrivateKey().toString('base64url')+'\n');await completed;
config.vars={...config.vars,VAPID_PUBLIC_KEY:keys.getPublicKey().toString('base64url'),VAPID_SUBJECT:'https://tinygpt.org'};
await writeFile(configPath,JSON.stringify(config,null,2)+'\n');console.log('Web Push signing key stored in Cloudflare. Public configuration updated.');
