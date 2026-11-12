/**
 * Shared look for every HTML page this worker serves (connector sign-in, /managed, member links).
 * Self-contained: no external fonts, images or scripts. Fleet pattern: copy this file as is
 * and change BRAND only.
 */
// `logo` (optional): the service's own icon as a data: URI (CSP img-src data:); replaces the text badge and the tab icon.
export const BRAND: { name: string; accent: string; mark: string; logo?: string } = { name: 'Zoho Analytics', accent: '#d9362c', mark: 'ZA', logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAFdUlEQVR4nOzdX2xTdRQH8O/5tXUUtnUjMUJidPwJQowJYQjOuDGDYaCSkGjUd2KGiSb6oCE+KGokGqORRMlU8MEHjUYTFWWb4WEZAoJkkagR1MDiXxIJdGOsG23v8fe7yBhsXXvHbY/dzieB3rbnNs357ndv7+9uvVFM0tl1jddmPbrTLq4AeAFAdQzMI0ICUxgz+gg4AbL/GMftQ4cI6T2JzgOnMQkUpPhcS+PcNOMxNnSvXfEWqEuYe5h49zVM22d17v270NUKCsA1PgM85RFaCRSHyonBKQO0RRmvFBLEhAFo4yfvYhA0FNla3dV1KledyfkC9fWxNPAMEz2uzQ/O9YxBT3gV2RdcL3PXjaOvpWG2h+guIrod6qox836DzPrxdtRjRgA3N9vNV+wLbX54XC89in7menvlc2MC6JvhvWHHRQNUqOwm6Q6/t1e4LIBkS+Mme9MKVSyt//V4xMg+YGD1yusy0Ype+8gMqKJxn45iJjK/cnfXSXd/ZARkYhXPafOLz306Sme9zZfuW8k1TfNsFL/YxQhU0Y0eBf4IYMPPQptfMm4UZDxvi1uOXngAt0GVGDe7/6l/TcNiz8R+gio546WXRG3zN0CJcL039jh5KZQM23vDhDlQIlzv3U64DkqE/fAzJ2o/EukIEMJM/giogBLhzp8bKFFRTGNUVY343esRXbTYX86Fz/Yj8/NRpHbv8pfDNK0DiK/fgNjS+rx1LpxY/Qo7WRPB4PvvIUzTOoDYTUuKWl+IaR0A4jMDlQeuL4DuhIVpAMI0AGEagDANQJgGIEwDEKYBCNMAhGkAwspmKiLWfBcq7nsQkbr59l3neNuZDLK9xzH8yYdId+1BOSiLEWBuqMPMJ59GZOGi3M137HOuxtW6dcpBWQQQW7bcvtMAv7hna/11ykBZbIKosgpBTWYdCboTFqYBCNMAhGkAwjQAYRqAMA1AmAYgTAMQpgEI0wCEaQDCQp+Mo9rZiG/chOiyW/3lXPjMaWR6vkVqZ5u/PF2FHkC89VHEVq3OW+fCia1u8efwB196HtNV6AHElq8sav1UE/75gFmVgcoD108xuhMWpgEI0wCEaQDCNABhGoAwDUCYBiBMAxCmAQjTAIRpAMI0AGEagDANQJgGIEwDEBZ+AOcGApUXUs8DZxFUQeukBhFI0PoChB5A+vDB0OvTPYcBL4uC2Vp/nXyveyzYV2YHrS9EZPPCG7cgRJkfv4epqYWpnQ2K5776lf9rKfu7kXpnOzCUmvA1uS8J768/YebMhalO2B+bHD837s9Uj/+KoR1tyB7pQd732nsCprISpqoKVJH72zv9L+374QhSX34OnB9GmOhMS1Nyql//8f/KXZfSEPFJKBGu94YBDUCI670h1gCkuN4bOw6+g5Jhe2+Ml/4USoTrvan+6sBRuzU6BlVifMz1/sJlrJg6oEqLyd/yXDiiofOv213yEFRp2F5HDL/qFv0Aaju+6bU326BKZVtV+95/3MLIMX3CDG91R2ZQRcXg/sRA9sWL90cCoPaD/Ya8R6CKipgepn37RqZqL5vVSnR8/YGN6GWo4rC9rens/mj0QzS2BpRsaewioiao8DDaE53d95Df4kvGzOu6gqjB/cz8G1QobC9/t/vYh65svjPuxLrbQ9ecGlxo12yDujrMO2wvF7h97HhPU771k2ub3DXm34Rebzgodwqvtaaje+dERXlPSdoXeMsge7NL0sZ5HmpizGm7oXnX9Sxf8528I2C0wXXN1w973ma70ka9/vzl7DHUOTu3/3aMIq/NbO/6o9D1AgUwWv/aVQ3M3gMesIJAtfaVam3yNVM+GDdlQ0ja26Q9qDptT+fus/P6Hyc69x7CJPwLAAD//+hj4sgAAAAGSURBVAMAkVKuC3vwX54AAAAASUVORK5CYII=' };

const CSS = `
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--fg:#1d2330;--muted:#5f6878;--line:#dfe3ea;--accent:${BRAND.accent};--ok:#1e7e34;--err:#c62828;--field:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#14161b;--card:#1d2027;--fg:#e8eaee;--muted:#9aa2b1;--line:#30343d;--field:#16181d}}
*{box-sizing:border-box}
a{color:var(--accent)}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:34rem;margin:2.5rem auto;padding:0 16px}
.brand{display:flex;align-items:center;gap:.7rem;margin:0 0 1.2rem}
.mark.logo{background:none}.mark img{width:40px;height:40px;border-radius:10px;display:block}
.mark{width:40px;height:40px;border-radius:10px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700;letter-spacing:.02em}
.brand b{font-size:1.05rem}.brand span{display:block;color:var(--muted);font-size:.85rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.4rem 1.4rem .6rem;box-shadow:0 1px 3px #0000000d}
h1{font-size:1.35rem;margin:0 0 .6rem}
p{margin:.4rem 0 1rem}
fieldset{border:0;border-top:1px solid var(--line);padding:1rem 0 .2rem;margin:0}
fieldset:first-of-type{border-top:0;padding-top:0}
legend{font-weight:600;padding:0;margin-bottom:.5rem}
label{display:block;font-size:.9rem;font-weight:500;margin:0 0 .85rem}
input,select{display:block;width:100%;margin-top:.3rem;padding:.6rem .7rem;font:inherit;color:inherit;background:var(--field);border:1px solid var(--line);border-radius:8px}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
button{font:inherit;font-weight:600;padding:.65rem 1rem;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;width:100%;margin:.2rem 0 .8rem}
button:hover{filter:brightness(1.07)}
a.btn{display:block;text-align:center;text-decoration:none;font-weight:600;padding:.75rem 1rem;border-radius:8px;background:var(--accent);color:#fff;margin:.4rem 0 1rem}a.btn:hover{filter:brightness(1.07)}a.btn.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}
ol.steps{padding-left:1.2rem;margin:.4rem 0 1rem}ol.steps li{margin:.3rem 0}
.big{font-size:2.4rem;line-height:1;margin:.2rem 0 .6rem}
button.secondary{background:transparent;color:var(--muted);border:1px solid var(--line)}
.row{display:flex;gap:.5rem}.row button{width:auto;flex:none}
.err,.ok{border-radius:8px;padding:.7rem .9rem;margin:0 0 1rem;font-size:.92rem}
.err{background:#c628281a;color:var(--err)}.ok{background:#1e7e341a}
.muted{color:var(--muted);font-size:.85rem}
code{font:.85em ui-monospace,SFMono-Regular,Menlo,monospace;background:#8882;padding:.1em .35em;border-radius:4px;word-break:break-all}
.copy{display:flex;gap:.5rem;align-items:stretch;margin:.3rem 0 1rem}
.copy input{margin:0;font:1rem ui-monospace,SFMono-Regular,Menlo,monospace}
.copy button{width:auto;margin:0;display:flex;align-items:center;gap:.35rem;white-space:nowrap}
footer{color:var(--muted);font-size:.8rem;text-align:center;margin:1.2rem 0}
`;

// Wires every [data-copy] button to copy the value of the element it names.
const COPY_JS = `document.querySelectorAll('[data-close]').forEach(function(b){b.addEventListener('click',function(){window.close();b.textContent='You can close this tab now'})});document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var t=document.getElementById(b.getAttribute('data-copy'));if(!t)return;var v=t.value||t.textContent;var done=function(){var o=b.innerHTML;b.textContent='Copied';setTimeout(function(){b.innerHTML=o},1500)};if(navigator.clipboard){navigator.clipboard.writeText(v).then(done,function(){t.select&&t.select();document.execCommand('copy');done()})}else{t.select&&t.select();document.execCommand('copy');done()}})})`;

const COPY_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

/** Tab icon (§12A): the brand mark on the accent colour, inline as an SVG data URI (no request, CSP img-src data:). */
export function faviconDataUri(): string {
  if (BRAND.logo) return BRAND.logo;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${BRAND.accent}"/><text x="32" y="42" font-family="system-ui,Segoe UI,Arial,sans-serif" font-size="${BRAND.mark.length > 1 ? 26 : 34}" font-weight="700" fill="#fff" text-anchor="middle">${BRAND.mark.replace(/[&<>"']/g, '')}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A read-only value with a copy button. `id` must be unique on the page. */
export function copyField(id: string, value: string, label = 'Copy'): string {
  return `<div class="copy"><input id="${esc(id)}" value="${esc(value)}" readonly aria-label="${esc(label)}"><button type="button" data-copy="${esc(id)}">${COPY_ICON}<span>${esc(label)}</span></button></div>`;
}

/** A full page: brand header, one card, the shared style; CSP allows only this page's own inline script. */
export function renderPage(body: string, opts: { status?: number; title?: string; subtitle?: string; formAction: string }): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const script = /data-(copy|close)=/.test(body) ? `<script nonce="${nonce}">${COPY_JS}</script>` : '';
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title ?? `Connect ${BRAND.name}`)}</title><link rel="icon" href="${faviconDataUri()}"><style>${CSS}</style></head><body><main>
<div class="brand">${BRAND.logo ? `<div class="mark logo"><img src="${esc(BRAND.logo)}" alt="${esc(BRAND.name)}"></div>` : `<div class="mark">${esc(BRAND.mark)}</div>`}<div><b>${esc(BRAND.name)} for Claude</b><span>${esc(opts.subtitle ?? 'MCP connector')}</span></div></div>
<div class="card">${body}</div>
<footer>Your credentials are encrypted and only used to call ${esc(BRAND.name)} for you.</footer>
</main>${script}</body></html>`,
    {
      status: opts.status ?? 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; form-action ${opts.formAction}; frame-ancestors 'none'; base-uri 'none'`,
        'Referrer-Policy': 'no-referrer',
      },
    },
  );
}
