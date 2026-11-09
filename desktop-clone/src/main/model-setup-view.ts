import { randomBytes } from 'node:crypto';

/** Self-contained first-run UI: only bundled assets and a nonce-authorized script. */
export function modelSetupDocument(icon: Buffer, font: Buffer): string {
  const nonce = randomBytes(18).toString('base64');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
  <title>Installing TinyGPT</title>
  <style>
    @font-face{font-family:Figtree;src:url('data:font/woff2;base64,${font.toString('base64')}') format('woff2');font-weight:300 900;font-display:swap}
    *{box-sizing:border-box}
    html,body{height:100%;margin:0;overflow:hidden}
    body{background:transparent;font-family:Figtree,system-ui,sans-serif;-webkit-font-smoothing:antialiased;color:#19191b}
    .setup{position:relative;width:100%;height:100%;overflow:hidden;border:1px solid #ffffffb8;border-radius:22px;background:#fcfcfd;user-select:none}
    .drag{position:absolute;inset:0 0 auto;height:48px;-webkit-app-region:drag}
    main{display:flex;align-items:center;flex-direction:column;padding:50px 56px 36px;text-align:center}
    .icon{display:block;width:60px;height:60px;border-radius:16px;box-shadow:0 3px 8px #0000000b}
    h1{margin:23px 0 0;font-size:26px;line-height:34px;letter-spacing:-.85px;font-weight:560}
    .description{margin:8px 0 0;min-height:21px;font-size:14px;line-height:21px;color:#717179;letter-spacing:-.1px;opacity:1;transform:translateY(0);transition:opacity 300ms ease,transform 300ms ease}
    .description.changing{opacity:0;transform:translateY(-3px)}
    .progress-group{width:300px;max-width:100%;margin-top:28px}
    progress{display:block;width:100%;height:4px;appearance:none;-webkit-appearance:none;border:0;border-radius:20px;overflow:hidden;background:#e8e8ed}
    progress::-webkit-progress-bar{background:#e8e8ed;border-radius:20px}
    progress::-webkit-progress-value{background:#25252a;border-radius:20px}
    .percent{margin:12px 0 0;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;color:#717179}
    .stop{margin-top:19px;padding:7px 14px;border:1px solid #e3e3e8;border-radius:20px;background:transparent;color:#707078;font:450 12px/18px Figtree,system-ui,sans-serif;cursor:pointer;-webkit-app-region:no-drag;transition:background 160ms ease,color 160ms ease}
    .stop:hover{background:#f0f0f3;color:#333338}
    .stop:focus-visible{outline:2px solid #76767e;outline-offset:3px}
    .stop:disabled{cursor:default;opacity:.6}
    @media(prefers-color-scheme:dark){
      body{color:#f3f3f5}
      .setup{background:#18181b;border-color:#ffffff12}
      .description{color:#97979f}
      .percent{color:#898991}
      progress,progress::-webkit-progress-bar{background:#313137}
      progress::-webkit-progress-value{background:#e8e8ed}
      .stop{border-color:#ffffff15;color:#9b9ba4}
      .stop:hover{background:#ffffff08;color:#ededf1}
    }
    @media(prefers-reduced-motion:reduce){.description,.stop{transition:none}}
  </style>
</head>
<body data-downloading="false">
  <section class="setup" aria-label="TinyGPT installation">
    <div class="drag" aria-hidden="true"></div>
    <main>
      <img class="icon" src="data:image/png;base64,${icon.toString('base64')}" alt="" width="60" height="60">
      <h1>Installing TinyGPT</h1>
      <p class="description" aria-live="off">Getting everything ready for you.</p>
      <div class="progress-group">
        <progress id="progress" aria-label="Installation progress" max="100" value="0"></progress>
        <p id="percent" class="percent" aria-hidden="true">0%</p>
      </div>
      <button class="stop" type="button">Stop installation</button>
    </main>
  </section>
  <script nonce="${nonce}">
    const description=document.querySelector('.description');
    const stop=document.querySelector('.stop');
    const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
    const messages=['Getting everything ready for you.','Setting up your on-device AI.','Getting ready for your first chat.'];
    let index=0,transition;
    const rotation=setInterval(()=>{
      if(reducedMotion.matches)return;
      description.classList.add('changing');
      transition=setTimeout(()=>{
        const available=document.body.dataset.downloading==='true'?[messages[0],'Downloading the essentials.',...messages.slice(1)]:messages;
        index=(index+1)%available.length;
        description.textContent=available[index];
        description.classList.remove('changing');
      },300);
    },4200);
    stop.addEventListener('click',()=>{
      stop.disabled=true;stop.textContent='Stopping…';
      clearInterval(rotation);clearTimeout(transition);
      description.classList.remove('changing');
      window.tinygptSetup.stop();
    });
  </script>
</body>
</html>`;
}
