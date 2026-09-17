/* 放喺 repo 嘅 api/tts.js
   ------------------------------------------------------------------
   家長貼咩詞表，就即場合成咩。

   成本控制唔係靠限制次數，係靠快取：同一段文字永遠產生同一段音訊，
   所以 Vercel Edge Network 可以永久快取。全香港第一個默 "Wednesday"
   嘅家長會叫一次 Google，之後所有人食 CDN。
   實際 API 呼叫量 ≈ 不重複字數，唔係總播放次數。
*/

export const config = { runtime: 'edge' };

/* ⚠️ 正式聲音。Google 各等級差價極大（WaveNet $4/1M vs Studio $160/1M），
   而等級係由呼叫方喺 request body 揀 —— 條 key 攔唔到。
   呢一行就係你同 40 倍帳單之間唯一嘅閘。 */
const VOICE = { languageCode: 'en-GB', name: 'en-GB-Wavenet-A' };

const MAX_CHARS = 600;
const ALLOWED = ['https://www.tiptonghk.com', 'https://tiptonghk.com'];

/* 只准試聽呢啲等級。就算 dev token 洩漏，都燒唔到 Studio（$160/1M）。 */
const AUDITION_OK = /^en-GB-(Wavenet|Standard|Neural2)-[A-F]$/;

export default async function handler(req) {
  const url  = new URL(req.url);
  const text = (url.searchParams.get('t') || '').trim().slice(0, MAX_CHARS);
  const slow = url.searchParams.get('s') === '1';

  if (!text) return new Response('missing text', { status: 400 });

  /* 試聽後門：淨係為咗喺手機上面 A/B 唔同聲音。
     冇 token、token 唔啱、或者個名唔喺白名單 → 一律用 VOICE。
     揀好聲之後，將 TTS_DEV_TOKEN 由 Vercel 刪走就即刻關閉。 */
  let voiceName = VOICE.name;
  const devToken = process.env.TTS_DEV_TOKEN;
  const asked    = url.searchParams.get('v');
  const given    = url.searchParams.get('dev');
  if (devToken && given === devToken && asked && AUDITION_OK.test(asked)) {
    voiceName = asked;
  }

  /* curl 偽造得到，只係擋住最低成本嘅網頁盜用。
     真正嘅成本上限喺 GCP 嗰邊嘅配額。
     ⚠️ 試聽要喺 Safari 直接打網址，嗰陣冇 origin／referer，
        所以呢度只喺「有 origin 但唔啱」先拒絕。 */
  const origin = req.headers.get('origin') || req.headers.get('referer') || '';
  if (origin && !ALLOWED.some(a => origin.startsWith(a))) {
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
          voice: { languageCode: VOICE.languageCode, name: voiceName },
          audioConfig: {
            audioEncoding: 'MP3',
            /* 喺 server 調慢，唔用 client 嘅 playbackRate ——
               playbackRate 會連音高一齊變，聽落似卡帶。
               Google 嘅 speakingRate 保持音高。 */
            speakingRate: slow ? 0.75 : 1.0
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
      /* 呢一行就係成本控制本身。唔好改短。
         ⚠️ 試聽期間唔同 v= 會各自快取，唔會互相覆蓋。 */
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
