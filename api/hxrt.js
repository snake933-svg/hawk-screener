/**
 * api/hxrt.js — 單一個股即時價格查詢
 * 三重備援：TWSE MIS → Yahoo Finance → TWSE 歷史
 * hawk-screener 獨立版
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const code = (req.query.code || '').trim().replace(/\.TW(O)?$/i, '');
  if (!code || !/^\d{4,6}$/.test(code))
    return res.status(400).json({ error: 'code required, e.g. ?code=3508' });

  const ua = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };
  function pn(s) { const v = parseFloat(String(s||'').replace(/,/g,'')); return isNaN(v)?0:v; }

  const now = new Date();
  const twH = (now.getUTCHours() + 8) % 24;
  const twM = now.getUTCMinutes();
  const isOTC = code.length === 5 || (parseInt(code) >= 6000 && parseInt(code) <= 6999);

  let close = 0, name = '', change = 0, changePct = 0, src = '';

  // ══ 來源1：TWSE/TPEX MIS 個股即時 ══
  // 9點到17點都能拿到今日最後成交價
  if (twH >= 8 && twH <= 17) {
    try {
      const ex = isOTC ? 'otc' : 'tse';
      const r = await fetch(
        `https://mis.twse.com.tw/stock/api/getStockInfo.asp?ex_ch=${ex}_${code}.tw&json=1&delay=0`,
        { headers: { ...ua, 'Referer': 'https://mis.twse.com.tw/' }, signal: AbortSignal.timeout(8000) }
      );
      if (r.ok) {
        const j = await r.json();
        const item = j.msgArray?.[0];
        if (item) {
          const z = item.z && item.z !== '-' ? pn(item.z) : 0;
          const y = pn(item.y);
          if (z > 0) {
            close = z; name = item.n?.trim()||code;
            change = Math.round((z-y)*100)/100;
            changePct = y>0 ? Math.round((z-y)/y*10000)/100 : 0;
            src = 'mis';
          }
        }
      }
    } catch(e) { console.warn('[hxrt] MIS:',e.message); }
  }

  // ══ 來源2：Yahoo Finance ══
  if (!close) {
    try {
      const sym = `${code}.${isOTC?'TWO':'TW'}`;
      const end = Math.floor(Date.now()/1000);
      const start = end - 5*86400;
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${start}&period2=${end}&interval=1d`,
        { headers: ua, signal: AbortSignal.timeout(10000) }
      );
      if (r.ok) {
        const j = await r.json();
        const result = j?.chart?.result?.[0];
        if (result) {
          const closes = result.indicators?.quote?.[0]?.close||[];
          const validCloses = closes.filter(x=>x&&x>0);
          const last = validCloses.slice(-1)[0];
          const prev = validCloses.slice(-2)[0];
          if (last > 0) {
            close = Math.round(last*100)/100;
            name = result.meta?.longName?.replace(' Co.,Ltd.','').replace(' Co., Ltd.','') || code;
            if (prev > 0) {
              change = Math.round((close-prev)*100)/100;
              changePct = Math.round((close-prev)/prev*10000)/100;
            }
            src = 'yahoo';
          }
        }
      }
    } catch(e) { console.warn('[hxrt] Yahoo:',e.message); }
  }

  // ══ 來源3：TWSE STOCK_DAY 歷史 ══
  if (!close && !isOTC) {
    try {
      const yyyymm = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}01`;
      const r = await fetch(
        `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${code}&date=${yyyymm}&response=json`,
        { headers: ua, signal: AbortSignal.timeout(10000) }
      );
      if (r.ok) {
        const j = await r.json();
        if (j.stat==='OK' && j.data?.length) {
          const last = j.data[j.data.length-1];
          const c = pn(last[6]);
          const p = j.data.length > 1 ? pn(j.data[j.data.length-2][6]) : 0;
          if (c > 0) {
            close = c; src = 'twse-history';
            if (p > 0) { change = Math.round((c-p)*100)/100; changePct = Math.round((c-p)/p*10000)/100; }
          }
        }
      }
    } catch(e) { console.warn('[hxrt] TWSE history:',e.message); }
  }

  if (!close) return res.status(404).json({ error: `無法取得 ${code} 的價格`, code, twH });

  const inMkt = (twH>=9&&twH<13)||(twH===13&&twM<=30);
  res.setHeader('Cache-Control', `s-maxage=${inMkt?60:300}, stale-while-revalidate`);
  return res.status(200).json({ code, name, close, change, changePct, src, time: now.toISOString() });
}
