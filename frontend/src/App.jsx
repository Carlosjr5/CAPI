import React, { useEffect, useState, useRef } from 'react'
import { Doughnut } from 'react-chartjs-2'
import { Chart, ArcElement, Tooltip, Legend } from 'chart.js'
import TradeTable from './TradeTable'
Chart.register(ArcElement, Tooltip, Legend)

export default function App(){
  const [trades, setTrades] = useState([])
  const [status, setStatus] = useState('Disconnected')
  const eventsRef = useRef(null)

  useEffect(()=>{ fetchTrades(); connectWS(); }, [])

  async function fetchTrades(){
    try{
      const res = await fetch('http://127.0.0.1:8000/trades')
      const data = await res.json()
      setTrades(data)
    }catch(e){
      console.error(e)
    }
  }

  function mapStatus(s){
    if(!s) return 'other'
    const v = s.toLowerCase()
    if(v.includes('placed') || v.includes('received')) return 'open'
    if(v.includes('filled') || v.includes('closed') || v.includes('rejected') || v.includes('error') || v.includes('ignored')) return 'closed'
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
        if(['received','placed','error','ignored'].includes(d.type)) fetchTrades()
      }catch(e){ console.error(e) }
    }
  }

  function pushEvent(msg){
    const el = eventsRef.current
    if(!el) return
    const d = document.createElement('div')
    d.className = 'evt'
    d.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`
    el.prepend(d)
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

          <TradeTable items={trades} onRefresh={fetchTrades} />
        </section>

        <aside className="right">
          <div className="card">
            <h3>Status distribution</h3>
            <Doughnut data={pieData} />
          </div>

          <div className="card events">
            <h3>Events</h3>
            <div ref={eventsRef} className="eventsList"></div>
          </div>
        </aside>
      </main>
    </div>
  )
}
