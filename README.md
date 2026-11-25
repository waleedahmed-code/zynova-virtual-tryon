# Zynova Virtual Try-On (Shopify)

Customer product page pe apni photo upload karta hai, aur AI wahi outfit ya jewellery us ki photo pe laga ke dikhata hai.
Aik hi Worker **saare clients** ke liye chalta hai. Har naye client ke liye bas uska config add karna hota hai.

```
Shopify product page ──► Cloudflare Worker (zynova-virtual-tryon) ──► Gemini image model
   (snippet + section)        API key yahan safe; client/origin check;        (gemini-3.1-flash-image)
                              rate limit; prompt yahin banta hai
```

## Files
| File | Kaam |
|---|---|
| `worker/src/index.js` | Cloudflare Worker (multi-client) |
| `worker/wrangler.toml` | Worker config + **CLIENTS list** |
| `worker/test/worker.test.mjs` | 22 unit tests (`npm test`) |
| `shopify/snippets/zy-virtual-tryon.liquid` | Asal UI: button, modal, upload, result, add to cart |
| `shopify/sections/zy-virtual-tryon.liquid` | Section wrapper, taa ke Customizer se add ho sake |

---

## 1) Worker deploy (sirf aik baar)

1. Gemini API key banayein: https://aistudio.google.com/apikey (billing on honi chahiye, image models free tier pe limited hote hain).
2. Terminal mein:
   ```bash
   cd worker
   npm install
   npx wrangler login
   npx wrangler secret put GEMINI_API_KEY     # key paste karein
   npx wrangler deploy
   ```
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
Har try-on Gemini ki aik image generation hai. Gemini ki current pricing yahan dekh lein: https://ai.google.dev/gemini-api/docs/pricing
Kharcha control karne ke teen tareeqe hain: per-IP limit (default 1 minute mein 4 try-ons), per-client `dailyLimit`, aur kisi client ko `"enabled": false` kar ke band karna.
Agar kisi client ka bajat kam ho to us ke config mein `"model": "gemini-3.1-flash-lite-image"` likh dein. Ye sasta hai, lekin quality thodi kam hai.

## Privacy
Customer ki photo browser mein 1024px tak chhoti ki jati hai, seedhi Gemini ko jati hai, aur **kahin save nahi hoti**: na Worker mein, na Shopify mein. Generate karne se pehle customer se consent checkbox lazmi tick karwaya jata hai.

## Test karna
```bash
cd worker && npm test        # 22 unit tests
npx wrangler tail            # live logs (errors yahan dikhenge)
```
