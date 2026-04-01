/**
 * api/hxb.js — 基本面（股本、董監持股、連續配息）
 * hawk-screener 獨立版
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const ua = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
  function pn(s) { const v = parseFloat(String(s||'').replace(/,/g,'')); return isNaN(v)?0:v; }

  try {
    const stocks = {};

    // 股本
    try {
      const r = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', { headers: ua, signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const data = await r.json();
        for (const item of (Array.isArray(data)?data:[])) {
          const code = (item['公司代號']||item['Code']||'').trim();
          if (!code||!/^\d{4}$/.test(code)) continue;
          const capital = pn(item['實收資本額']||0) / 1e8;
          if (capital>0) { if(!stocks[code]) stocks[code]={}; stocks[code].capital = Math.round(capital*10)/10; }
        }
      }
    } catch(e) { console.error('[hxb] capital:', e.message); }

    // 連續配息（近5年）
    try {
      const now = new Date();
      const yearDivs = {};
      for (let y=0; y<5; y++) {
        const year = now.getFullYear()-y;
        const strDate = `${year}0101`;
        const endDate = y===0 ? now.toISOString().slice(0,10).replace(/-/g,'') : `${year}1231`;
        try {
          const r = await fetch(
            `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json&strDate=${strDate}&endDate=${endDate}`,
            { headers: ua, signal: AbortSignal.timeout(20000) }
          );
          if (!r.ok) continue;
          const j = await r.json();
          if (j.stat!=='OK'||!j.data?.length) continue;
          for (const row of j.data) {
            const code = (row[1]||'').trim();
            if (!code||!/^\d{4,6}$/.test(code)) continue;
            if (pn(row[5])>0) {
              if (!yearDivs[code]) yearDivs[code]=new Set();
              yearDivs[code].add(year);
            }
          }
        } catch { continue; }
        await new Promise(r=>setTimeout(r,100));
      }
      for (const [code,years] of Object.entries(yearDivs)) {
        let streak=0;
        for (let y=0; y<5; y++) {
          if (years.has(now.getFullYear()-y)) streak++;
          else break;
        }
        if (streak>0) {
          if (!stocks[code]) stocks[code]={};
          stocks[code].dividendStreak = streak;
        }
      }
    } catch(e) { console.error('[hxb] dividend:', e.message); }

    for (const code of Object.keys(stocks)) {
      if (!stocks[code].capital)        stocks[code].capital = 0;
      if (!stocks[code].directorPct)    stocks[code].directorPct = 0;
      if (!stocks[code].dividendStreak) stocks[code].dividendStreak = 0;
    }

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json({ stocks, total: Object.keys(stocks).length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
