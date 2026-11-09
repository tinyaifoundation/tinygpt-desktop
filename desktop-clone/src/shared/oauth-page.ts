// Shared by the desktop loopback and hosted native OAuth return pages.
export interface OAuthPageAssets { regular: string; medium: string; semibold: string; hero: string; brand?: string }
export function oauthPageHtml(assets: OAuthPageAssets, nonce: string, script: string): string {
  const brand = (assets.brand ?? 'TinyGPT').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TinyGPT · Connect your account</title><style nonce="${nonce}">
      @font-face{font-family:Figtree;src:url('${assets.regular}') format('woff2');font-style:normal;font-weight:400;font-display:swap}
      @font-face{font-family:Figtree;src:url('${assets.medium}') format('woff2');font-style:normal;font-weight:500;font-display:swap}
      @font-face{font-family:Figtree;src:url('${assets.semibold}') format('woff2');font-style:normal;font-weight:600;font-display:swap}
      :root{color-scheme:light dark;--bg:#f5f6f8;--card:#ffffff;--text:#1a1c1f;--muted:#71717a;--button:#18181b;--on-button:#ffffff;--border:#e9eaed}
      *{box-sizing:border-box}
      body{margin:0;min-height:100svh;display:grid;place-items:center;padding:48px 24px;background:var(--bg);color:var(--text);font-family:Figtree,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
      main{width:min(100%,460px);overflow:hidden;text-align:center;border:1px solid var(--border);border-radius:24px;background:var(--card);box-shadow:0 20px 70px #132a5010}
      .hero{height:168px;background:#91b6fa;overflow:hidden}.hero img{display:block;width:100%;height:100%;object-fit:cover;object-position:center top}.content{padding:28px 28px 32px}
      .brand{margin:0 0 20px;color:var(--text);font-size:14px;font-weight:600;line-height:20px;letter-spacing:-.3px}
      .status-icon{display:grid;place-items:center;width:56px;height:56px;margin:0 auto 20px;border-radius:50%;background:#edf3ff;color:#5077c9;font-size:26px}.status-icon::before{content:'↗'}body[data-status=connected] .status-icon{background:#e9f7ef;color:#2c8760}body[data-status=connected] .status-icon::before{content:'✓'}body[data-status=error] .status-icon{background:#fff1ed;color:#a75339}body[data-status=error] .status-icon::before{content:'!'}
      h1{margin:0 0 12px;font-size:28px;line-height:1.3;letter-spacing:-.8px;font-weight:600;text-wrap:balance}
      p{margin:0;color:var(--muted);font-size:14px;line-height:1.6;overflow-wrap:anywhere}
      #detail{max-width:360px;margin-inline:auto}
      button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:24px;padding:10px 22px;border:0;border-radius:99px;background:var(--button);color:var(--on-button);font:500 14px/20px Figtree,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;transition:background-color .15s}
      .footnote{margin-top:22px;font-size:11px}.footnote a{color:inherit;text-decoration:none}.footnote a:hover{text-decoration:underline}
      button:hover{background:color-mix(in srgb,var(--button) 90%,var(--bg))}
      button:focus-visible{outline:2px solid var(--text);outline-offset:3px}
      button:disabled{opacity:.5;cursor:wait}
      @media(prefers-reduced-motion:reduce){button{transition:none}}
      @media(max-width:380px){body{padding:24px 16px}.content{padding:24px 20px}h1{font-size:25px}.hero{height:140px}}
      @media(prefers-color-scheme:dark){:root{--bg:#111214;--card:#1b1c1f;--text:#ededef;--muted:#a2a3a8;--border:#303136;--button:#ededef;--on-button:#171717}.status-icon{background:#283551;color:#b0caff}body[data-status=connected] .status-icon{background:#203d30;color:#92d9b2}body[data-status=error] .status-icon{background:#4a2b25;color:#f5b8a3}}
      </style></head><body><main><div class="hero"><img src="${assets.hero}" alt=""></div><div class="content"><p class="brand">${brand}</p><span class="status-icon" aria-hidden="true"></span><h1>Finishing your connection</h1><p id="detail" role="status" aria-live="polite">Checking your account…</p><p class="footnote"><a href="https://tinygpt.org" rel="noreferrer">tinygpt.org</a></p></div></main><script nonce="${nonce}">${script}</script></body></html>`;
}
