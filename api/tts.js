/* 放喺 repo 嘅 api/tts.js
   ------------------------------------------------------------------
   成本控制唔係靠限制次數，係靠快取：同一段文字 + 同一把聲永遠產生
   同一段音訊，所以 Vercel Edge Network 可以永久快取。
   全香港第一個默 "Wednesday" 嘅家長會叫一次 Google，之後所有人食 CDN。
*/

export const config = { runtime: 'edge' };

/* ⚠️ client 只可以傳 'c'／'f'／'d' 呢幾個代號，傳唔到完整 voice name。
   Google 各等級差價極大（WaveNet $4/1M vs Studio $160/1M），
   而等級係喺 request body 揀嘅 —— 條 key 攔唔到。
   用固定對照表就算有人偽造請求，最貴都只係燒到 $4/1M 嗰檔。 */
const VOICES = {
  c: 'en-GB-Wavenet-C',   // Cathy
  f: 'en-GB-Wavenet-F',   // Ava（2026-10-01 加；同 Cathy 同一個 WaveNet 價錢）
  d: 'en-GB-Wavenet-D'    // Deacons
};
const DEFAULT_VOICE = VOICES.c;

const MAX_CHARS = 600;
/* 2026-10-24：加返兩個 vercel.app 舊網址。
   gv_fail 數據（10/20–10/23）：2 部機喺 dictation-coach.vercel.app 用緊，
   其中一部係「加咗落主畫面」嘅家長 —— 佢每次都由舊網址開，
   舊版呢度擋咗佢（403），所以佢只係聽到 CDN 已經快取咗嘅字係 Cathy，
   其餘全部跌返基本發聲。唔可以叫佢哋轉網址：localStorage 跟網址走，
   一轉就冇晒儲低嘅詞表同 Plus 解鎖。 */
const ALLOWED = [
  'https://www.tiptonghk.com',
  'https://tiptonghk.com',
  'https://dictation-coach.vercel.app',
  'https://dictation-coach-k5l2.vercel.app'
];

export default async function handler(req) {
  const url  = new URL(req.url);
  const text = (url.searchParams.get('t') || '').trim().slice(0, MAX_CHARS);

  if (!text) return new Response('missing text', { status: 400 });

  /* 速度由 client 傳入，唔喺呢度寫死 —— 家長嘅「讀字速度」同 🐢 掣
     一定要對 Cathy 生效。0.5–1.2 夾硬 clamp：speakingRate 唔影響成本，
     但傳個癲數會產生聽唔明嘅音訊，而嗰個結果會被永久快取。
     舊版嘅 &s=1 照支援，免得前端未更新就變咗正常速。 */
  let rate = parseFloat(url.searchParams.get('r'));
  if (!isFinite(rate)) rate = url.searchParams.get('s') === '1' ? 0.75 : 0.92;
  /* 下限 0.4 配合段落默書 —— 嗰邊 clamp 係 0.4–1.2，單詞係 0.5–1.2。
     server 收窄過 client 嘅話，家長揀咗最慢會靜靜哋變成冇咁慢。 */
  rate = Math.max(0.4, Math.min(1.2, rate));

  /* 對照表查唔到就跌返預設，唔會 error —— 前端升級咗傳新代號、
     後端未 deploy 嘅時候，家長聽到嘅係 Cathy，唔係一個壞掉嘅播放器。 */
  const voiceName = VOICES[(url.searchParams.get('v') || '').toLowerCase()] || DEFAULT_VOICE;

  /* curl 偽造得到，只係擋住最低成本嘅網頁盜用。
     真正嘅成本上限喺 GCP 嗰邊嘅配額設定。
     ⚠️ Safari 直接打網址係冇 referer 嘅，所以只喺「有 origin 但唔啱」先拒絕，
        否則你自己喺瀏覽器測試會被自己擋住。
     ⚠️ 'null' 照放行：有啲 iOS 情況（例如主畫面 app）會送 Origin: null，
        擋咗佢唔會慳到錢（curl 一樣偽造到），只會令真家長冇聲。 */
  const origin = req.headers.get('origin') || req.headers.get('referer') || '';
  /* 比較完整嘅 origin（scheme + host），唔用 startsWith：
     舊寫法會放行 https://tiptonghk.com.evil.com 呢類網址。 */
  let o = '';
  try { o = origin && origin !== 'null' ? new URL(origin).origin : ''; } catch (e) { o = 'bad'; }
  if (o && !ALLOWED.includes(o)) {
    return new Response('forbidden', { status: 403 });
  }

  const key = process.env.GOOGLE_TTS_KEY;
  if (!key) return new Response('GOOGLE_TTS_KEY not set', { status: 500 });

  let g;
  try {
    g = await fetch(
      'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: 'en-GB', name: voiceName },
          audioConfig: {
            audioEncoding: 'MP3',
            /* 一定要用 Google 嘅 speakingRate，唔可以用 client 嘅
               playbackRate —— playbackRate 會連音高一齊變，聽落似卡帶。 */
            speakingRate: rate
          }
        })
      });
  } catch (e) {
    return new Response('upstream unreachable', { status: 502 });
  }

  if (!g.ok) {
    const detail = await g.text();
    console.error('TTS upstream', g.status, detail.slice(0, 300));
    return new Response('tts failed', { status: 502 });
  }

  const { audioContent } = await g.json();
  if (!audioContent) return new Response('empty audio', { status: 502 });

  const bin = Uint8Array.from(atob(audioContent), c => c.charCodeAt(0));

  return new Response(bin, {
    headers: {
      'Content-Type': 'audio/mpeg',
      /* 呢一行就係成本控制本身。唔好改短。 */
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
