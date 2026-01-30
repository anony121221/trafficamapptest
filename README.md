# Traffic Camera Map (GitHub Pages web build)

## What changed vs your desktop build
- Removed explicit `User-Agent` request header usage (browsers don't let you set it reliably).
- Disabled DFW 511 integration because it used a client secret + Node `https` (not safe/available in the browser).
- Added `hls.js` script include (renderer expects `window.Hls`).
- Added `window.PROXY_BASE_URL` support for optional proxying of HLS/API calls.

## Local test
From this folder run:
- `python -m http.server 5173`
then open `http://localhost:5173/`

## GitHub Pages
1. Put `index.html`, `style.css`, `renderer.js` in the repo root (or `/docs`).
2. Repo Settings → Pages → Deploy from branch → select `main` and `/root` (or `/docs`).

## Optional: Proxy for CORS/HLS
If some APIs or HLS streams fail due to CORS, deploy a Cloudflare Worker proxy and set:

```html
<script>
  window.PROXY_BASE_URL = "https://YOUR-WORKER.your-subdomain.workers.dev/proxy?url=";
</script>
```

before `renderer.js` is loaded.

(Use an allowlist in the Worker; don't deploy an open proxy.)
