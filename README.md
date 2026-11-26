# Zynova Virtual Try-On (Shopify)

Customer product page pe apni photo upload karta hai, aur AI wahi outfit ya jewellery us ki photo pe laga ke dikhata hai.
Aik hi Worker **saare clients** ke liye chalta hai. Har naye client ke liye bas uska config add karna hota hai.

```
Shopify product page ──► Cloudflare Worker (zynova-virtual-tryon) ──► Workers AI: FLUX.2 [klein] 4B  (default, FREE)
   (snippet + section)        client/origin check; rate limit;        └─► ya Gemini (optional, paid, behtar quality)
                              prompt yahin banta hai
```

## AI provider
| | Workers AI (default) | Gemini (optional) |
|---|---|---|
| Kharcha | Free: 10,000 neurons/roz ≈ 80 try-ons/roz | Har image ka paisa |
| Key | Koi key nahi | `GEMINI_API_KEY` secret |
| Quality | Theek, input images 504px tak | Behtar detail (1024px) |
| Badalna | `PROVIDER = "workers-ai"` | `PROVIDER = "gemini"` ya client mein `"provider": "gemini"` |

Free limit khatam ho jaye to customer ko "today's limit" message milta hai; agle din (00:00 UTC) reset.
`<worker-url>/health` batata hai kaun sa provider chal raha hai aur binding/key mili ya nahi.

## Files
| File | Kaam |
|---|---|
| `worker/src/index.js` | Cloudflare Worker (multi-client) |
| `worker/wrangler.toml` | Worker config + **CLIENTS list** |
| `worker/test/worker.test.mjs` | 36 unit tests (`npm test`) |
| `shopify/mia-cara/snippets/mia-virtual-tryon.liquid` | Mia Cara theme ka block snippet (main-product → virtual_try_on) |
| `shopify/snippets/zy-virtual-tryon.liquid` | Asal UI: button, modal, upload, result, add to cart |
| `shopify/sections/zy-virtual-tryon.liquid` | Section wrapper, taa ke Customizer se add ho sake |

---

## 1) Worker deploy (sirf aik baar)

1. Terminal mein (Workers AI ke liye koi key nahi chahiye; `[ai]` binding wrangler.toml mein hai):
   ```bash
   cd worker
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
2. (Sirf agar Gemini use karna ho) `npx wrangler secret put GEMINI_API_KEY` aur `PROVIDER = "gemini"`.
3. Deploy ke baad URL milega, jaise `https://zynova-virtual-tryon.<account>.workers.dev`. Check karein: `<URL>/health` pe `{"ok":true,...}` aana chahiye.
4. (Optional) Roz ki limit per client:
   ```bash
   npx wrangler kv namespace create USAGE
   ```
   Is ki id `wrangler.toml` mein `[[kv_namespaces]]` wale hisse mein daal ke comment hata dein, phir dobara `npx wrangler deploy`.

> GitHub auto-deploy (Murphy Bed visualizer jaisa) chahiye to `worker/` folder ko naye repo mein daal ke Cloudflare dashboard → Workers → Connect to Git kar dein. Secret dashboard pe set karein.

## 2) Naya client add karna

`worker/wrangler.toml` → `CLIENTS` mein aik entry add karein, phir `npx wrangler deploy`:

```json
"clientname": {
  "origins": ["https://store.com", "https://www.store.com", "https://store-handle.myshopify.com"],
  "dailyLimit": 300,
  "promptNote": "Optional: brand ke products ke baare mein aik line"
}
```
- `origins` mein store ke **saare** domains hone chahiye: custom domain, www, aur `.myshopify.com`. Jo domain list mein nahi hoga, wahan se request block ho jayegi.
- **Mia Cara:** maine `https://miacara.myshopify.com` andaaze se likha hai. Shopify Admin → Settings → Domains se asli myshopify handle confirm kar ke theek kar dein.
- Theme Customizer ka preview `*.shopifypreview.com` pe chalta hai. Preview mein test karna ho to woh URL bhi origins mein add karein (baad mein hata dein).

## 3) Shopify theme mein lagana

1. Online Store → Themes → **Edit code**.
2. `snippets/` mein naya snippet `zy-virtual-tryon` banayein aur snippet file ka code paste karein.
3. `sections/` mein naya section `zy-virtual-tryon` banayein aur section file ka code paste karein.
4. Button lagane ke **do tareeqe** hain:
   - **A. Section (aasaan):** Customize → Product template → Add section → *Virtual Try-On* → Worker URL + Client ID (`miacara`) bharein.
   - **B. Add to cart ke bilkul neeche (behtar conversion):** Product information mein *Custom liquid* block add karein aur ye paste karein:
     ```liquid
     {% render 'zy-virtual-tryon', product: product, worker_url: 'https://zynova-virtual-tryon.XXXX.workers.dev', client_id: 'miacara', accent: '#7a1f3d' %}
     ```

### Har product ka control (product tags se)
| Tag | Asar |
|---|---|
| `tryon:off` | Is product pe button nahi aayega |
| `tryon:clothing` / `tryon:jewelry` | Category zabardasti set karein |
| `tryon:earrings`, `tryon:necklace`, `tryon:ring`, `tryon:bangles`, `tryon:nosepin`, `tryon:tikka`, `tryon:watch`, `tryon:anklet` | Jewellery ki type set karein |

Bina tag ke, system product ke title, type aur tags se khud detect karta hai (jhumka → earrings, kangan → bangles, waghera).

## Kharcha (andaaza)
Workers AI pe roz 10,000 neurons free hain (≈80 try-ons). Zyada chahiye to Workers Paid plan ($5/mahina) pe $0.011 per 1,000 neurons. Gemini use karein to us ki pricing: https://ai.google.dev/gemini-api/docs/pricing
Kharcha control karne ke teen tareeqe hain: per-IP limit (default 1 minute mein 4 try-ons), per-client `dailyLimit`, aur kisi client ko `"enabled": false` kar ke band karna.
Agar kisi client ka bajat kam ho to us ke config mein `"model": "gemini-3.1-flash-lite-image"` likh dein. Ye sasta hai, lekin quality thodi kam hai.

## Product photo se sirf kapre (garment cut-out)
Product photo mein model ho to AI us ka chehra/haath/bag bhi copy kar leta tha. Ab customer ke browser mein hi
Google MediaPipe (free) product photo ko segment karta hai aur **sirf kapre** (jewellery ke liye sirf jewellery)
safed background pe AI ko bhejta hai. Model (~16 MB) pehli baar popup kholne pe download hota hai, phir browser cache.
Load na ho sake to khud purane tareeqe pe chala jata hai (`productCropTop` = upar se % kaatna).

## Privacy
Customer ki photo browser mein 1024px tak chhoti ki jati hai, seedhi Gemini ko jati hai, aur **kahin save nahi hoti**: na Worker mein, na Shopify mein. Generate karne se pehle customer se consent checkbox lazmi tick karwaya jata hai.

## Test karna
```bash
cd worker && npm test        # 36 unit tests
npx wrangler tail            # live logs (errors yahan dikhenge)
```
