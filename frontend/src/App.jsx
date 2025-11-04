import React, { useEffect, useState, useRef } from 'react'
// Chart.js removed - use simple status boxes instead
import TradeTable from './TradeTable'
// Chart registration removed

export default function App(){
  const [trades, setTrades] = useState([])
  const [status, setStatus] = useState('Disconnected')
  const eventsRef = useRef(null)
  // manual place-test form state
  const [formSecret, setFormSecret] = useState('')
  const [formSymbol, setFormSymbol] = useState('BTCUSDT')
  const [formSide, setFormSide] = useState('BUY')
  const [formSizeUsd, setFormSizeUsd] = useState('100')
  const [placing, setPlacing] = useState(false)
  const [lastOrderResult, setLastOrderResult] = useState(null)
  const [lastOrderQuery, setLastOrderQuery] = useState(null)
  const [currentPrices, setCurrentPrices] = useState({})
  const priceIntervalRef = useRef(null)

  useEffect(()=>{ 
    fetchTrades(); 
    connectWS();
    
    // Start periodic price updates for open positions
    if (priceIntervalRef.current) {
      clearInterval(priceIntervalRef.current);
    }
    priceIntervalRef.current = setInterval(() => {
      updatePricesOnly(trades);
    }, 5000); // Update every 5 seconds

    return () => {
      if (priceIntervalRef.current) {
        clearInterval(priceIntervalRef.current);
      }
    };
  }, [trades])

  async function fetchTrades(){
    try{
      const apiBase = getApiBase()
      const res = await fetch((apiBase || '') + '/trades')
      const data = await res.json()
      setTrades(data)
      // Fetch prices for open positions
      await fetchPricesForOpenPositions(data)
    }catch(e){
      console.error(e)
    }
  }

  async function updatePricesOnly(tradesData){
    const openTrades = tradesData.filter(t => mapStatus(t.status) === 'open')
    const symbols = [...new Set(openTrades.map(t => t.symbol))]
    
    if(symbols.length === 0) return; // No open positions, skip
    
    const newPrices = {...currentPrices}
    for(const symbol of symbols){
      try{
        const apiBase = getApiBase()
        const res = await fetch((apiBase || '') + `/price/${symbol}`)
        const data = await res.json()
        if(data.price){
          newPrices[symbol] = data.price
        }
      }catch(e){
        console.error(`Failed to fetch price for ${symbol}:`, e)
      }
    }
    setCurrentPrices(newPrices)
  }

  function calculatePnL(trade){
    const currentPrice = currentPrices[trade.symbol]
    if(!currentPrice || !trade.price || !trade.size) return null
    
    const entryPrice = trade.price
    const multiplier = trade.signal.toUpperCase() === 'BUY' ? 1 : -1
    const pnl = (currentPrice - entryPrice) * trade.size * multiplier
    return pnl
  }

  function mapStatus(s){
    if(!s) return 'other'
    const v = s.toLowerCase()
    if(v === 'placed') return 'open'
    if(v.includes('filled') || v.includes('closed') || v.includes('rejected') || v.includes('error') || v.includes('ignored') || v === 'signal') return 'closed'
    return 'other'
  }

  function connectWS(){
    // In dev (Vite) the app is served from a different origin (e.g. localhost:5173).
    // Use the backend WebSocket directly when running the dev server so we connect to the FastAPI WS at :8000.
    const usingDevFrontend = location.hostname === 'localhost' && (location.port === '5173' || location.port === '3000')
    const wsUrl = usingDevFrontend ? 'ws://127.0.0.1:8000/ws' : ((location.protocol === 'https:') ? 'wss://' : 'ws://') + location.host + '/ws'
    const ws = new WebSocket(wsUrl)
    ws.onopen = ()=>{ setStatus('Connected'); pushEvent('WebSocket connected') }
    ws.onclose = ()=>{ setStatus('Disconnected'); pushEvent('WebSocket disconnected') }
    ws.onmessage = (m)=>{
      try{
        const d = JSON.parse(m.data)
        pushEvent(JSON.stringify(d))
        if(['received','placed','error','ignored'].includes(d.type)) {
          fetchTrades()
        }
      }catch(e){ console.error(e) }
    }
  }

  function getApiBase(){
    // Default behavior:
    // - When running the dev frontend locally (localhost:5173/3000) use the API base
    //   defined by Vite env var VITE_API_BASE if present, otherwise fall back to
    //   the deployed Railway URL so dev frontend talks to the deployed backend.
    const usingDevFrontend = location.hostname === 'localhost' && (location.port === '5173' || location.port === '3000')
    let viteBase = ''
    try{ viteBase = (import.meta && import.meta.env && import.meta.env.VITE_API_BASE) || '' }catch(e){}
    const defaultRailway = 'https://capi-production-7bf3.up.railway.app'
    return usingDevFrontend ? (viteBase || defaultRailway) : ''
  }

  function pushEvent(msg){
    const el = eventsRef.current
    if(!el) return
    const d = document.createElement('div')
    d.className = 'evt'
    d.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`
    el.prepend(d)
    // keep the events container scrolled to top so new events don't push the page down
    try{ el.scrollTop = 0 }catch(e){}
    while(el.children.length>50) el.removeChild(el.lastChild)
  }

  const counts = trades.reduce((acc, t)=>{ const k = mapStatus(t.status); acc[k] = (acc[k]||0)+1; acc.total++; return acc }, {open:0, closed:0, other:0, total:0})

  const pieData = {
    labels: ['Open','Closed','Other'],
    datasets:[{data:[counts.open, counts.closed, counts.other], backgroundColor:['#10b981','#ef4444','#94a3b8']}]
  }

  return (
    <div className="app">
      <header>
        <div className="brand">CAPI Dashboard</div>
        <div className="status">{status}</div>
      </header>
      <main>
        <section className="left">
          <div className="kpis">
            <div className="kpi"><div className="label">Open</div><div className="value">{counts.open}</div></div>
            <div className="kpi"><div className="label">Closed</div><div className="value">{counts.closed}</div></div>
            <div className="kpi"><div className="label">Total</div><div className="value">{counts.total}</div></div>
          </div>

          {counts.open > 0 && (
            <div className="card">
              <h3>Current Position</h3>
              {trades.filter(t => mapStatus(t.status) === 'open').map(t => {
                const pnl = calculatePnL(t)
                const pnlColor = pnl > 0 ? '#10b981' : pnl < 0 ? '#ef4444' : '#94a3b8'
                const pnlText = pnl !== null ? `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : 'Loading...'
                return (
                  <div key={t.id} style={{padding:8, border:'1px solid #ccc', marginBottom:4, borderRadius:4}}>
                    <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                      <div>
                        <strong>{t.signal}</strong> {t.symbol} at ${Number(t.price).toFixed(2)}
                      </div>
                      <div style={{color: pnlColor, fontWeight: 'bold', fontSize: '1.1em'}}>
                        {pnlText}
                      </div>
                    </div>
                    <div className="muted">Opened: {new Date(t.created_at*1000).toLocaleString()}</div>
                    <div className="muted">ID: {t.id.slice(0,8)}...</div>
                  </div>
                )
              })}
            </div>
          )}

          <TradeTable items={trades} onRefresh={fetchTrades} />
        </section>

        <aside className="right">
          <div className="card">
            <h3>Status</h3>
            <div style={{display:'flex',gap:10,alignItems:'center',marginTop:8}}>
              <div style={{padding:8,borderRadius:8,background:'rgba(16,185,129,0.15)',color:'#10b981',fontWeight:700}}>Open: {counts.open}</div>
              <div style={{padding:8,borderRadius:8,background:'rgba(239,68,68,0.12)',color:'#ef4444',fontWeight:700}}>Closed: {counts.closed}</div>
              <div style={{padding:8,borderRadius:8,background:'rgba(148,163,184,0.12)',color:'#94a3b8',fontWeight:700}}>Other: {counts.other}</div>
            </div>
          </div>
          
          <div className="card events">
            <h3>Events</h3>
            <div ref={eventsRef} className="eventsList"></div>
          </div>

          <div className="card">
            <h3>Manual demo order</h3>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              <input placeholder="TradingView secret" type="password" value={formSecret} onChange={e=>setFormSecret(e.target.value)} />
              <input placeholder="Symbol (e.g. BTCUSDT)" value={formSymbol} onChange={e=>setFormSymbol(e.target.value)} />
              <select value={formSide} onChange={e=>setFormSide(e.target.value)}>
                <option>BUY</option>
                <option>SELL</option>
              </select>
              <input placeholder="Size (USD) e.g. 100" value={formSizeUsd} onChange={e=>setFormSizeUsd(e.target.value)} />
              <div style={{display:'flex',gap:8}}>
                <button disabled={placing} onClick={async ()=>{
                  setPlacing(true)
                  try{
                    const apiBase = getApiBase()
                    const body = { secret: formSecret, signal: formSide, symbol: formSymbol, size_usd: formSizeUsd }
                    const headers = { 'Content-Type': 'application/json' }
                    // Prefer header-based secret if provided (backend checks header first)
                    if(formSecret) headers['Tradingview-Secret'] = formSecret
                    const res = await fetch(apiBase + '/debug/place-test', { method: 'POST', headers, body: JSON.stringify(body) })
                    let parsed = null
                    try{ parsed = await res.json() }catch(e){ parsed = await res.text() }
                    try{ pushEvent(`[place-test] status=${res.status} resp=${JSON.stringify(parsed)}`) }catch(e){ console.log(e) }
                    setLastOrderResult({ status: res.status, body: parsed })
                    if(res.ok){ fetchTrades() }
                  }catch(e){ pushEvent(`[place-test] error ${e.message || e}`) }
                  setPlacing(false)
                }}>{placing ? 'Placing...' : 'Place demo order'}</button>
                <button onClick={()=>{ setFormSecret(''); setFormSizeUsd('100'); setFormSymbol('BTCUSDT'); setFormSide('BUY') }}>Reset</button>
              </div>
            </div>
          </div>
          {lastOrderResult && (
            <div className="card">
              <h3>Last order result</h3>
              <div className="muted">status: {lastOrderResult.status}</div>
              <pre style={{maxHeight:140,overflow:'auto',whiteSpace:'pre-wrap'}}>{JSON.stringify(lastOrderResult.body,null,2)}</pre>
              {lastOrderResult.body && lastOrderResult.body.orderId && (
                <div style={{display:'flex',gap:8,marginTop:8}}>
                  <div>OrderId: <strong>{lastOrderResult.body.orderId}</strong></div>
                  <button onClick={()=>{ navigator.clipboard && navigator.clipboard.writeText(lastOrderResult.body.orderId) }}>Copy</button>
                  <button onClick={async ()=>{
                    // Query the backend for Bitget order details
                    try{
                      setLastOrderQuery({loading:true})
                      const apiBase = getApiBase()
                      const body = { secret: formSecret, orderId: lastOrderResult.body.orderId }
                      const headers = { 'Content-Type': 'application/json' }
                      if(formSecret) headers['Tradingview-Secret'] = formSecret
                      const res = await fetch(apiBase + '/debug/order-status', { method: 'POST', headers, body: JSON.stringify(body) })
                      let parsed = null
                      try{ parsed = await res.json() }catch(e){ parsed = await res.text() }
                      setLastOrderQuery({ loading:false, status: res.status, body: parsed })
                    }catch(e){ setLastOrderQuery({ loading:false, error: String(e) }) }
                  }}>Query Bitget</button>
                </div>
              )}
              {lastOrderQuery && (
                <div style={{marginTop:8}}>
                  {lastOrderQuery.loading ? <div className="muted">Querying...</div> : (
                    lastOrderQuery.error ? <div className="muted">Error: {lastOrderQuery.error}</div> : (
                      <pre style={{maxHeight:160,overflow:'auto',whiteSpace:'pre-wrap'}}>{JSON.stringify(lastOrderQuery.body,null,2)}</pre>
                    )
                  )}
                </div>
              )}
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}
