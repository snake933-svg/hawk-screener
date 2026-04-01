/**
 * api/hxp.js — 股價歷史資料
 * hawk-screener 獨立版
 * ★ volume 統一以「股」為單位回傳，前端 parseRaw 除以 1000 得「張」
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const symbol = (req.query.symbol || '').trim().replace(/\.TW(O)?$/i, '');
  const days   = Math.min(parseInt(req.query.days) || 90, 365);
  const source = req.query.source || 'twse';

  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const ua = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  function pn(s) {
    if (!s || s === '--' || s === '' || s === 'N/A') return 0;
    return parseFloat(String(s).replace(/,/g, '')) || 0;
  }

  function dateToTs(str) {
    const c = String(str).replace(/[\/\-]/g, '');
    const y = c.slice(0,4), m = c.slice(4,6), d = c.slice(6,8);
    return Math.floor(new Date(`${y}-${m}-${d}T08:00:00+08:00`).getTime() / 1000);
  }

  function isOTC(id) {
    if (id.length === 5) return true;
    const n = parseInt(id);
    return n >= 6000 && n <= 6999;
  }

  async function fetchTWSE(id, numDays) {
    const today = new Date();
    const records = [];
    const months = Math.ceil(numDays / 22) + 1;
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setMonth(d.getMonth() - i);
      const yyyymm = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}01`;
      try {
        const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${id}&date=${yyyymm}&response=json`;
        const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const j = await r.json();
        if (j.stat !== 'OK' || !j.data?.length) continue;
        for (const row of j.data) {
          const dateStr = row[0]?.trim();
          if (!dateStr) continue;
          const parts = dateStr.split('/');
          if (parts.length !== 3) continue;
          const westernYear = parseInt(parts[0]) + 1911;
          const ts = dateToTs(`${westernYear}/${parts[1]}/${parts[2]}`);
          const volumeShares = Math.round(pn(row[1]));
          const open = pn(row[3]), high = pn(row[4]), low = pn(row[5]), close = pn(row[6]);
          if (close > 0) records.push({ ts, open, high, low, close, volumeShares });
        }
      } catch { continue; }
    }
    return records;
  }

  async function fetchTPEX(id, numDays) {
    const today = new Date();
    const records = [];
    const months = Math.ceil(numDays / 22) + 1;
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setMonth(d.getMonth() - i);
      const rocYear = d.getFullYear() - 1911;
      const mm = String(d.getMonth()+1).padStart(2,'0');
      try {
        const url = `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${rocYear}/${mm}&s=${id},asc,0&output=json`;
        const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const j = await r.json();
        if (!j.aaData?.length) continue;
        for (const row of j.aaData) {
          const dateStr = row[0]?.trim();
          if (!dateStr) continue;
          const parts = dateStr.split('/');
          if (parts.length !== 3) continue;
          const westernYear = parseInt(parts[0]) + 1911;
          const ts = dateToTs(`${westernYear}/${parts[1]}/${parts[2]}`);
          const volumeShares = Math.round(pn(row[1]) * 1000);
          const open = pn(row[3]), high = pn(row[4]), low = pn(row[5]), close = pn(row[6]);
          if (close > 0) records.push({ ts, open, high, low, close, volumeShares });
        }
      } catch { continue; }
    }
    return records;
  }

  async function fetchYahoo(id, numDays) {
    const suffix = id.length <= 4 ? '.TW' : '.TWO';
    const sym = `${id}${suffix}`;
    const end   = Math.floor(Date.now() / 1000);
    const start = end - numDays * 86400 * 1.4;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${start}&period2=${end}&interval=1d&includePrePost=false`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { headers: { ...ua }, signal: AbortSignal.timeout(12000) });
        if (!r.ok) continue;
        const j = await r.json();
        const result = j?.chart?.result?.[0];
        if (result) return result;
      } catch {}
    }
    return null;
  }

  async function fetchExRights(id) {
    try {
      const end = new Date().toISOString().slice(0,10).replace(/-/g,'');
      const d3y = new Date(); d3y.setFullYear(d3y.getFullYear() - 3);
      const start = d3y.toISOString().slice(0,10).replace(/-/g,'');
      const r = await fetch(
        `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json&strDate=${start}&endDate=${end}&stockNo=${id}`,
        { headers: ua, signal: AbortSignal.timeout(10000) }
      );
      if (!r.ok) return [];
      const j = await r.json();
      if (j.stat !== 'OK' || !j.data?.length) return [];
      return j.data.map(row => {
        const p = String(row[0]||'').split('/');
        if (p.length !== 3) return null;
        const ts = Math.floor(new Date(`${parseInt(p[0])+1911}-${p[1].padStart(2,'0')}-${p[2].padStart(2,'0')}T08:00:00+08:00`).getTime()/1000);
        const pn2 = s => parseFloat(String(s||'').replace(/,/g,''))||0;
        return { ts, prevClose: pn2(row[3]), refPrice: pn2(row[4])||pn2(row[5]) };
      }).filter(r => r && r.ts > 0 && r.prevClose > 0 && r.refPrice > 0);
    } catch { return []; }
  }

  function calcAdjClose(records, exRights) {
    if (!exRights.length) return records.map(r => r.close);
    const sorted = [...records].sort((a,b) => a.ts - b.ts);
    const factors = exRights.sort((a,b) => a.ts - b.ts)
      .map(ex => ({ ts: ex.ts, factor: ex.prevClose > 0 ? ex.refPrice / ex.prevClose : 1 }));
    return sorted.map(rec => {
      let adj = rec.close;
      for (const f of factors) if (f.ts > rec.ts) adj *= f.factor;
      return Math.round(adj * 100) / 100;
    });
  }

  function toYahooFormat(records, id, adjCloses) {
    const allSorted = [...records].sort((a,b) => a.ts - b.ts);
    const sorted = allSorted.slice(-days);
    if (!sorted.length) return null;
    return {
      meta: { symbol: `${id}.TW`, currency: 'TWD', exchangeName: 'TPE', dataSource: 'TWSE' },
      timestamps: sorted.map(r => r.ts),
      indicators: {
        quote: [{
          open:   sorted.map(r => r.open),
          high:   sorted.map(r => r.high),
          low:    sorted.map(r => r.low),
          close:  sorted.map(r => r.close),
          volume: sorted.map(r => r.volumeShares),
        }],
        adjclose: [{
          adjclose: adjCloses
            ? sorted.map(r => { const i = allSorted.findIndex(s => s.ts === r.ts); return adjCloses[i] ?? r.close; })
            : sorted.map(r => r.close),
        }],
      },
    };
  }

  try {
    let result = null, dataSource = 'unknown';
    if (source !== 'yahoo') {
      try {
        let records, adjCloses = null;
        if (isOTC(symbol)) {
          records = await fetchTPEX(symbol, days);
          dataSource = 'TPEX';
        } else {
          const [recs, exRights] = await Promise.all([fetchTWSE(symbol, days), fetchExRights(symbol)]);
          records = recs;
          adjCloses = calcAdjClose(records, exRights);
          dataSource = exRights.length > 0 ? 'TWSE+TWT49U' : 'TWSE';
        }
        if (records.length >= 5) result = toYahooFormat(records, symbol, adjCloses);
      } catch (e) { console.error(`[hxp] TWSE/TPEX failed (${symbol}):`, e.message); }
    }
    if (!result && source !== 'twse') {
      const yahooResult = await fetchYahoo(symbol, days);
      if (yahooResult) { result = yahooResult; dataSource = 'Yahoo'; }
    }
    if (!result) return res.status(404).json({ error: `無法取得 ${symbol} 的股價資料`, symbol });
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
    return res.status(200).json({ chart: { result: [result], error: null }, _source: dataSource, _symbol: symbol });
  } catch (err) {
    return res.status(500).json({ error: err.message, symbol });
  }
}
