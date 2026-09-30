/* 放喺 repo 嘅 api/ocr.js（同 api/tts.js 同一個資料夾）
   ------------------------------------------------------------------
   影相入字：將相片交俾 Google Cloud Vision（DOCUMENT_TEXT_DETECTION）認字，
   原封不動將 fullTextAnnotation 交返前端。排版／排序全部喺前端做
   （同 Tesseract 用同一套邏輯），呢度只負責轉交。

   ⚠️ 成本控制：唔好似 tts 咁靠快取 —— 每張相都唔同，一定要叫 Google。
      Vision 每月頭 1,000 張免費，之後大約 US$1.5／1,000 張。
      真正嘅上限要喺 GCP 設：Cloud Vision API → 配額 →
      「Requests per day」設例如 300，超過就會 429，前端自動跌返 Tesseract。
   ⚠️ 相片唔會喺呢度儲存或者記錄（連 console.error 都唔會印相片內容）。
*/

export const config = { runtime: 'edge' };

const ALLOWED = ['https://www.tiptonghk.com', 'https://tiptonghk.com'];
/* 前端已經縮到長邊 1600px、JPEG 0.85，正常 200–600KB，base64 之後 < 1MB。
   3MB 上限純粹防有人掟大檔燒錢／拖慢。 */
const MAX_B64 = 3 * 1024 * 1024;

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  /* 同 tts 一樣：擋住最低成本嘅網頁盜用；curl 偽造得到，真上限喺 GCP 配額。 */
  const origin = req.headers.get('origin') || req.headers.get('referer') || '';
  if (origin && !ALLOWED.some(a => origin.startsWith(a))) {
    return new Response('forbidden', { status: 403 });
  }

  /* 可以用獨立一條 key；冇設就用返 tts 嗰條（要喺 GCP 將 Vision API
     加入嗰條 key 嘅「API 限制」白名單，否則 Google 會回 403）。 */
  const key = process.env.GOOGLE_VISION_KEY || process.env.GOOGLE_TTS_KEY;
  if (!key) return new Response('no key', { status: 500 });

  let body;
  try { body = await req.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
  const img = (body && typeof body.img === 'string') ? body.img : '';
  if (!img || img.length > MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(img.slice(0, 200))) {
    return new Response('bad image', { status: 400 });
  }

  let g;
  try {
    g = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: img },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          /* 英文為主；加埋繁中等佢認得中文意思欄，前端會剷走，
             唔會再似 Tesseract 咁將中文讀成 BAR、WER 呢類假英文。 */
          imageContext: { languageHints: ['en', 'zh-Hant'] }
        }]
      })
    });
  } catch (e) {
    return new Response('upstream unreachable', { status: 502 });
  }

  if (!g.ok) {
    const detail = await g.text();
    console.error('Vision upstream', g.status, detail.slice(0, 300));
    return new Response('vision failed', { status: g.status === 429 ? 429 : 502 });
  }

  const j = await g.json();
  const r = (j.responses && j.responses[0]) || {};
  if (r.error) {
    console.error('Vision error', JSON.stringify(r.error).slice(0, 300));
    return new Response('vision error', { status: 502 });
  }

  /* 只交返 fullTextAnnotation：textAnnotations 係重複資料，體積大一倍。 */
  return new Response(JSON.stringify({ full: r.fullTextAnnotation || null }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
