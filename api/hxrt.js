/**
 * api/hxrt.js — 單一股票即時報價（持倉用）
 * 來源：TWSE 盤中即時 → TWSE STOCK_DAY → Yahoo Finance
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const code = (req.query.code || '').trim().replace(/\D/g,'');
  if (!code) return res.status(400).json({ error: 'code required' });

  const ua = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
  function pn(s) { return parseFloat(String(s||'').replace(/,/g,''))||0; }

  const now = new Date();
  const twH = (now.getUTCHours()+8)%24;
  const twM = now.getUTCMinutes();
  const inMkt = (twH===9&&twM>=0)||(twH>=10&&twH<13)||(twH===13&&twM<=30);

  // ── 1. 盤中：TWSE 即時 ──
  if (inMkt) {
    try {
      const ex = parseInt(code) >= 6000 ? 'otc' : 'tse';
      const r = await fetch(
        `https://mis.twse.com.tw/stock/api/getStockInfo.asp?ex_ch=${ex}_${code}.tw&json=1&delay=0`,
        { headers: { ...ua, 'Referer': 'https://mis.twse.com.tw/' }, signal: AbortSignal.timeout(8000) }
      );
      if (r.ok) {
        const j = await r.json();
        const item = j.msgArray?.[0];
        if (item) {
          const close = pn(item.z || item.y);
          const prev  = pn(item.y);
          if (close > 0) {
            res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
            return res.status(200).json({
              code, close, prev,
              change: Math.round((close-prev)*100)/100,
              changePct: prev > 0 ? Math.round((close-prev)/prev*10000)/100 : 0,
              name: item.n?.trim() || code,
              source: 'TWSE-realtime', time: now.toISOString(),
            });
          }
        }
      }
    } catch(e) { console.error('[hxrt] mis failed:', e.message); }
  }

  // ── 2. Yahoo Finance（盤後或備援）──
  try {
    const suffix = parseInt(code) >= 6000 ? '.TWO' : '.TW';
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}?interval=1d&range=2d`,
      { headers: ua, signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice > 0) {
        const close = meta.regularMarketPrice;
        const prev  = meta.previousClose || meta.chartPreviousClose || close;
        res.setHeader('Cache-Control', `s-maxage=${inMkt?60:900}, stale-while-revalidate`);
        return res.status(200).json({
          code, close, prev,
          change: Math.round((close-prev)*100)/100,
          changePct: prev > 0 ? Math.round((close-prev)/prev*10000)/100 : 0,
          name: meta.shortName || code,
          source: 'Yahoo', time: now.toISOString(),
        });
      }
    }
  } catch(e) { console.error('[hxrt] Yahoo failed:', e.message); }

  // ── 3. TWSE STOCK_DAY 月資料 ──
  try {
    const yyyymm = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}01`;
    const r = await fetch(
      `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${code}&date=${yyyymm}&response=json`,
      { headers: ua, signal: AbortSignal.timeout(10000) }
    );
    if (r.ok) {
      const j = await r.json();
      if (j.stat === 'OK' && j.data?.length) {
        const last = j.data[j.data.length-1];
        const prev = j.data.length>1 ? j.data[j.data.length-2] : last;
        const close = pn(last[6]), prevClose = pn(prev[6]);
        if (close > 0) {
          res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
          return res.status(200).json({
            code, close, prev: prevClose,
            change: Math.round((close-prevClose)*100)/100,
            changePct: prevClose > 0 ? Math.round((close-prevClose)/prevClose*10000)/100 : 0,
            source: 'TWSE-daily', time: now.toISOString(),
          });
        }
      }
    }
  } catch(e) { console.error('[hxrt] STOCK_DAY failed:', e.message); }

  return res.status(404).json({ error: `無法取得 ${code} 價格` });
}
