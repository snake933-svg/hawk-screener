/**
 * api/hxq.js — 全市場即時/收盤報價
 * 優先順序：
 *   1. mis.twse.com.tw（盤中+盤後30分鐘內，有今日最後成交）
 *   2. TWSE STOCK_DAY_ALL（盤後資料發布後，約15:30以後）
 *   3. TPEX（上櫃補齊）
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ua = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://mis.twse.com.tw/',
  };
  function pn(s) { const v = parseFloat(String(s||'').replace(/,/g,'')); return isNaN(v)?0:v; }

  const now = new Date();
  const twH = (now.getUTCHours() + 8) % 24;
  const twM = now.getUTCMinutes();
  // 盤中：9:00~13:30，盤後緩衝：13:30~15:30（仍用mis取今日最後成交）
  const useMIS = (twH >= 9 && twH < 15) || (twH === 15 && twM <= 30);
  const isAfterPublish = twH >= 16; // 16點後 STOCK_DAY_ALL 才有今日資料

  const stocks = {};

  // ── 來源1：mis.twse.com.tw 全市場快照 ──
  if (useMIS) {
    try {
      // 分批抓：上市全市場
      const r = await fetch(
        'https://mis.twse.com.tw/stock/api/getStockInfo.asp?ex_ch=tse_%40.tw&json=1&delay=0',
        { headers: ua, signal: AbortSignal.timeout(12000) }
      );
      if (r.ok) {
        const j = await r.json();
        for (const item of (j.msgArray || [])) {
          const code = item.c?.trim();
          if (!code || !/^\d{4}$/.test(code)) continue;
          // z=最新成交價, y=昨收, a=賣一, b=買一
          const close = pn(item.z !== '-' ? item.z : item.y);
          const prev  = pn(item.y);
          if (close <= 0) continue;
          const change = close - prev;
          stocks[code] = {
            close,
            change: Math.round(change * 100) / 100,
            changePct: prev > 0 ? Math.round(change / prev * 10000) / 100 : 0,
            volume: Math.round(pn(item.v)),
            name: item.n?.trim() || code,
            market: 'TWSE',
            src: 'mis',
          };
        }
        console.log(`[hxq] mis.twse: ${Object.keys(stocks).length} stocks`);
      }
    } catch (e) {
      console.error('[hxq] mis.twse failed:', e.message);
    }
  }

  // ── 來源2：TWSE STOCK_DAY_ALL（收盤後補齊或備援）──
  if (Object.keys(stocks).length < 200) {
    try {
      const r = await fetch(
        'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
        { headers: { 'User-Agent': ua['User-Agent'], 'Accept': 'application/json' },
          signal: AbortSignal.timeout(20000) }
      );
      if (r.ok) {
        const data = await r.json();
        for (const item of (Array.isArray(data) ? data : [])) {
          const code = (item.Code || item['股票代號'])?.trim();
          if (!code || !/^\d{4}$/.test(code)) continue;
          if (stocks[code]) continue; // mis已有則保留（今日成交優先）
          const close  = pn(item.ClosingPrice || item['收盤價']);
          const change = pn(item.Change       || item['漲跌價差']);
          const vol    = Math.round(pn(item.TradeVolume || item['成交股數']) / 1000);
          const name   = (item.Name || item['股票名稱'])?.trim() || code;
          if (close <= 0) continue;
          const prev = close - change;
          stocks[code] = {
            close,
            change: Math.round(change * 100) / 100,
            changePct: prev > 0 ? Math.round(change / prev * 10000) / 100 : 0,
            volume: vol, name, market: 'TWSE', src: 'daily',
          };
        }
        console.log(`[hxq] STOCK_DAY_ALL added, total: ${Object.keys(stocks).length}`);
      }
    } catch (e) {
      console.error('[hxq] STOCK_DAY_ALL failed:', e.message);
    }
  }

  // ── 來源3：TPEX 上櫃 ──
  try {
    const r = await fetch(
      'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
      { headers: { 'User-Agent': ua['User-Agent'], 'Accept': 'application/json' },
        signal: AbortSignal.timeout(20000) }
    );
    if (r.ok) {
      const data = await r.json();
      for (const item of (Array.isArray(data) ? data : [])) {
        const code = (item.SecuritiesCompanyCode || item['股票代號'])?.trim();
        if (!code || !/^\d{4,5}$/.test(code) || stocks[code]) continue;
        const close  = pn(item.Close || item['收盤價']);
        const change = pn(item.Change || item['漲跌']);
        const vol    = Math.round(pn(item.TradingShares || 0) / 1000);
        const name   = (item.CompanyName || item['股票名稱'])?.trim() || code;
        if (close <= 0) continue;
        const prev = close - change;
        stocks[code] = {
          close,
          change: Math.round(change * 100) / 100,
          changePct: prev > 0 ? Math.round(change / prev * 10000) / 100 : 0,
          volume: vol, name, market: 'TPEX', src: 'tpex',
        };
      }
    }
  } catch (e) {
    console.error('[hxq] TPEX failed:', e.message);
  }

  if (Object.keys(stocks).length < 100) {
    return res.status(503).json({
      error: '市場資料暫時無法取得，請稍後重試',
      total: Object.keys(stocks).length,
      twH, twM, useMIS,
    });
  }

  // 快取策略：盤中1分鐘，收盤緩衝期5分鐘，盤後15分鐘
  const inMarket = (twH >= 9 && twH < 13) || (twH === 13 && twM <= 30);
  const inBuffer = useMIS && !inMarket;
  const cacheAge = inMarket ? 60 : inBuffer ? 300 : 900;

  res.setHeader('Cache-Control', `s-maxage=${cacheAge}, stale-while-revalidate`);
  return res.status(200).json({
    stocks,
    total: Object.keys(stocks).length,
    time: now.toISOString(),
    twH, twM, useMIS, inMarket,
  });
}
