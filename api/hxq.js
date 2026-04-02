/**
 * api/hxq.js — 全市場即時報價
 * 盤中：TWSE 即時成交資料（每分鐘更新）
 * 盤後：STOCK_DAY_ALL 收盤價
 * hawk-screener 獨立版
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const ua = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
  function pn(s) { const v = parseFloat(String(s||'').replace(/,/g,'')); return isNaN(v)?0:v; }

  // 台灣時間
  const now = new Date();
  const twH = (now.getUTCHours() + 8) % 24;
  const twM = now.getUTCMinutes();
  const isMarketOpen = (twH === 9 && twM >= 0) || (twH >= 10 && twH < 13) || (twH === 13 && twM <= 30);
  const isAfterClose = twH >= 14 || (twH === 13 && twM > 30);

  try {
    const stocks = {};

    // ── 方法1：TWSE 盤中即時（盤中優先）──
    if (isMarketOpen) {
      try {
        const r = await fetch(
          'https://mis.twse.com.tw/stock/api/getStockInfo.asp?ex_ch=tse_%40.tw&json=1&delay=0',
          { headers: { ...ua, 'Referer': 'https://mis.twse.com.tw/' }, signal: AbortSignal.timeout(10000) }
        );
        if (r.ok) {
          const j = await r.json();
          for (const item of (j.msgArray || [])) {
            const code = item.c?.trim();
            if (!code || !/^\d{4}$/.test(code)) continue;
            const close  = pn(item.z || item.y);  // z=成交價, y=昨收
            const prev   = pn(item.y);
            const change = close - prev;
            const vol    = Math.round(pn(item.v));
            const name   = item.n?.trim() || code;
            if (close > 0) {
              stocks[code] = {
                close, change: Math.round(change*100)/100,
                changePct: prev > 0 ? Math.round(change/prev*10000)/100 : 0,
                volume: vol, name, market: 'TWSE', realtime: true,
              };
            }
          }
        }
      } catch(e) { console.error('[hxq] mis.twse failed:', e.message); }
    }

    // ── 方法2：TWSE STOCK_DAY_ALL（盤後或補齊）──
    if (Object.keys(stocks).length < 100) {
      try {
        const r = await fetch(
          'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
          { headers: ua, signal: AbortSignal.timeout(20000) }
        );
        if (r.ok) {
          const data = await r.json();
          for (const item of (Array.isArray(data) ? data : [])) {
            const code = (item.Code || item['股票代號'])?.trim();
            if (!code || !/^\d{4}$/.test(code)) continue;
            if (stocks[code]) continue; // 盤中已有則跳過
            const close  = pn(item.ClosingPrice  || item['收盤價']);
            const change = pn(item.Change        || item['漲跌價差']);
            const vol    = Math.round(pn(item.TradeVolume || item['成交股數']) / 1000);
            const name   = (item.Name || item['股票名稱'])?.trim() || code;
            if (close <= 0) continue;
            const prev = close - change;
            stocks[code] = {
              close, change: Math.round(change*100)/100,
              changePct: prev > 0 ? Math.round(change/prev*10000)/100 : 0,
              volume: vol, name, market: 'TWSE', realtime: false,
            };
          }
        }
      } catch(e) { console.error('[hxq] STOCK_DAY_ALL failed:', e.message); }
    }

    // ── 方法3：TPEX 上櫃（補齊）──
    try {
      const r = await fetch(
        'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
        { headers: ua, signal: AbortSignal.timeout(20000) }
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
            close, change: Math.round(change*100)/100,
            changePct: prev > 0 ? Math.round(change/prev*10000)/100 : 0,
            volume: vol, name, market: 'TPEX', realtime: false,
          };
        }
      }
    } catch(e) { console.error('[hxq] TPEX failed:', e.message); }

    if (Object.keys(stocks).length < 100)
      return res.status(503).json({ error: 'TWSE/TPEX 暫時無法取得', total: Object.keys(stocks).length });

    // 盤中快取短（1分鐘），盤後快取長（15分鐘）
    const cacheAge = isMarketOpen ? 60 : (isAfterClose ? 900 : 300);
    res.setHeader('Cache-Control', `s-maxage=${cacheAge}, stale-while-revalidate`);
    return res.status(200).json({
      stocks,
      total: Object.keys(stocks).length,
      time: now.toISOString(),
      isMarketOpen,
      source: isMarketOpen ? 'TWSE-realtime' : 'TWSE-daily',
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
