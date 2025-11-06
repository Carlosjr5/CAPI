import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TradeTable from './TradeTable'

const STORAGE_TOKEN_KEY = 'capi_token'
const STORAGE_ROLE_KEY = 'capi_role'

const DEFAULT_LEVERAGE_FALLBACK = (() => {
  try {
    const raw = import.meta?.env?.VITE_DEFAULT_LEVERAGE
    if (raw === undefined || raw === null || raw === '') return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  } catch (error) {
    console.warn('[ui] unable to parse VITE_DEFAULT_LEVERAGE', error)
    return null
  }
})()

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const numberFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 })
const leverageFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

const isFiniteNumber = (value) => Number.isFinite(Number(value))

export default function App(){
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_TOKEN_KEY) || '')
  const [role, setRole] = useState(() => localStorage.getItem(STORAGE_ROLE_KEY) || '')
  const [authChecked, setAuthChecked] = useState(false)
  const [loginUsername, setLoginUsername] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  const [trades, setTrades] = useState([])
  const tradesRef = useRef([])
  const [status, setStatus] = useState('Disconnected')
  const eventsRef = useRef(null)
  const wsRef = useRef(null)
  const priceIntervalRef = useRef(null)
  const [currentPrices, setCurrentPrices] = useState({})

  const [formSecret, setFormSecret] = useState('')
  const [formSymbol, setFormSymbol] = useState('BTCUSDT')
  const [formSide, setFormSide] = useState('BUY')
  const [formSizeUsd, setFormSizeUsd] = useState('100')
  const [placing, setPlacing] = useState(false)
  const [lastOrderResult, setLastOrderResult] = useState(null)
  const [lastOrderQuery, setLastOrderQuery] = useState(null)

  const isAdmin = role === 'admin'

  const handleLogout = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close() } catch (error) {}
      wsRef.current = null
    }
    if (priceIntervalRef.current) {
      clearInterval(priceIntervalRef.current)
      priceIntervalRef.current = null
    }
    setToken('')
    setRole('')
    setStatus('Disconnected')
    setTrades([])
    tradesRef.current = []
    setCurrentPrices({})
    setFormSecret('')
    setFormSymbol('BTCUSDT')
    setFormSide('BUY')
    setFormSizeUsd('100')
    setLastOrderResult(null)
    setLastOrderQuery(null)
    setLoginUsername('')
    setLoginPassword('')
    setLoginError('')
    localStorage.removeItem(STORAGE_TOKEN_KEY)
    localStorage.removeItem(STORAGE_ROLE_KEY)
    setAuthChecked(true)
  }, [])

  const formatCurrency = useCallback((value) => {
    const num = Number(value)
    return Number.isFinite(num) ? currencyFormatter.format(num) : '—'
  }, [])

  const formatNumber = useCallback((value, digits = 4) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return '—'
    if (digits !== 4) {
      return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(num)
    }
    return numberFormatter.format(num)
  }, [])

  const formatLeverage = useCallback((value) => {
    const num = Number(value)
    if (!Number.isFinite(num) || num <= 0) return '—'
    return `${leverageFormatter.format(num)}x`
  }, [])

  const isLocalFrontend = useCallback(() => {
    if (typeof window === 'undefined') return false
    const host = window.location.hostname
    const port = window.location.port
    const localHosts = ['localhost', '127.0.0.1']
    const localPorts = ['5173', '5174', '3000']
    return localHosts.includes(host) && (localPorts.includes(port) || port === '')
  }, [])

  const getApiBase = useCallback(() => {
    let viteBase = ''
    try {
      viteBase = import.meta?.env?.VITE_API_BASE || ''
    } catch (error) {
      console.warn('[ui] unable to read VITE_API_BASE', error)
    }
    const defaultLocalApi = 'http://127.0.0.1:8000'
    if (isLocalFrontend()) {
      return viteBase || defaultLocalApi
    }
    return ''
  }, [isLocalFrontend])

  const buildApiUrl = useCallback((path) => {
    const base = getApiBase()
    const normalizedBase = base ? base.replace(/\/$/, '') : ''
    return `${normalizedBase}${path}`
  }, [getApiBase])

  const buildWsUrl = useCallback(() => {
    const base = getApiBase()
    if (base) {
      try {
        const parsed = new URL(base)
        parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
        parsed.pathname = '/ws'
        parsed.search = ''
        parsed.hash = ''
        return parsed.toString()
      } catch (error) {
        const sanitized = base.replace(/\/+$/, '')
        return sanitized.replace(/^http(s)?:/i, (_, secure) => (secure ? 'wss:' : 'ws:')) + '/ws'
      }
    }
    if (typeof window === 'undefined') return ''
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${window.location.host}/ws`
  }, [getApiBase])

  useEffect(() => {
    const verifyToken = async () => {
      if (!token) {
        setAuthChecked(true)
        return
      }
      try {
        const res = await fetch(buildApiUrl('/auth/me'), {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (!res.ok) {
          throw new Error('unauthorized')
        }
        const data = await res.json()
        const newRole = data.role || 'user'
        setRole(newRole)
        localStorage.setItem(STORAGE_TOKEN_KEY, token)
        localStorage.setItem(STORAGE_ROLE_KEY, newRole)
        setAuthChecked(true)
      } catch (error) {
        console.error('Token verification failed', error)
        handleLogout()
      }
    }
    verifyToken()
  }, [token, handleLogout, buildApiUrl])

  useEffect(() => {
    if (!authChecked || !token) {
      return
    }

    fetchTrades()
    connectWS()

    if (priceIntervalRef.current) {
      clearInterval(priceIntervalRef.current)
    }
    priceIntervalRef.current = setInterval(() => {
      updatePricesOnly()
    }, 5000)

    return () => {
      if (priceIntervalRef.current) {
        clearInterval(priceIntervalRef.current)
        priceIntervalRef.current = null
      }
      if (wsRef.current) {
        try { wsRef.current.close() } catch (error) {}
        wsRef.current = null
      }
    }
  }, [authChecked, token])

  async function fetchTrades(){
    if (!token) return
    try{
      const res = await fetch(buildApiUrl('/trades'), { headers: authHeaders() })
      if(res.status === 401 || res.status === 403){
        handleLogout()
        return
      }
      const data = await res.json()
      const sorted = Array.isArray(data) ? [...data].sort((a,b)=>((b?.created_at||0) - (a?.created_at||0))) : []
      setTrades(sorted)
      tradesRef.current = sorted
      await fetchPricesForOpenPositions(sorted)
    }catch(error){
      console.error('[trades] fetch error', error)
    }
  }

  async function fetchPricesForOpenPositions(tradesData){
    await updatePricesOnly(tradesData)
  }

  async function updatePricesOnly(tradesData){
    if (!token) return
    const source = Array.isArray(tradesData) ? tradesData : (Array.isArray(tradesRef.current) ? tradesRef.current : [])
    const openTrades = source.filter(t => mapStatus(t.status) === 'open')
    const symbols = [...new Set(openTrades.map(t => t.symbol))]
    if(symbols.length === 0) return

    const updates = {}
    for(const symbol of symbols){
      try{
        const res = await fetch(buildApiUrl(`/price/${symbol}`), { headers: authHeaders() })
        if(res.status === 401 || res.status === 403){
          handleLogout()
          return
        }
        const data = await res.json()
        if(data && data.price){
          updates[symbol] = data.price
        }
      }catch(error){
        console.error(`[price] failed for ${symbol}`, error)
      }
    }
    if(Object.keys(updates).length){
      setCurrentPrices(prev => ({ ...prev, ...updates }))
    }
  }

  function calculatePnL(trade){
    const currentPrice = Number(currentPrices[trade.symbol])
    const entryPrice = Number(trade.price)
    const sizeValue = Number(trade.size)
    if(!Number.isFinite(currentPrice) || !Number.isFinite(entryPrice) || !Number.isFinite(sizeValue)) return null
    const multiplier = trade.signal?.toUpperCase() === 'BUY' ? 1 : -1
    return (currentPrice - entryPrice) * sizeValue * multiplier
  }

  function mapStatus(s){
    if(!s) return 'other'
    const v = s.toLowerCase()
    if(v === 'placed') return 'open'
    if(v.includes('filled') || v.includes('closed') || v.includes('rejected') || v.includes('error') || v.includes('ignored') || v === 'signal') return 'closed'
    return 'other'
  }

  function connectWS(){
    if (!token) return
    if (wsRef.current){
      try { wsRef.current.close() } catch (error) {}
      wsRef.current = null
    }
    const wsBase = buildWsUrl()
    if (!wsBase){
      console.warn('[ws] unable to determine websocket base URL')
      return
    }
    const socket = new WebSocket(`${wsBase}?token=${encodeURIComponent(token)}`)
    wsRef.current = socket
    socket.onopen = ()=>{ setStatus('Connected'); pushEvent('WebSocket connected') }
    socket.onclose = (event)=>{
      setStatus('Disconnected')
      pushEvent('WebSocket disconnected')
      wsRef.current = null
      if(event && event.code === 1008){
        pushEvent('WebSocket authentication failed; logging out.')
        handleLogout()
      }else if(token){
        setTimeout(()=>{
          if(token && !wsRef.current){
            connectWS()
          }
        }, 3000)
      }
    }
    socket.onmessage = (event)=>{
      try{
        const payload = JSON.parse(event.data)
        pushEvent(JSON.stringify(payload))
        if(['received','placed','error','ignored','closed'].includes(payload.type)) {
          fetchTrades()
        }
      }catch(error){ console.error('[ws] message parse error', error) }
    }
  }

  function authHeaders(extra = {}){
    if(!token) return { ...extra }
    return { ...extra, Authorization: `Bearer ${token}` }
  }

  function pushEvent(msg){
    const el = eventsRef.current
    if(!el) return
    if (el.dataset && el.dataset.empty === 'true'){
      el.dataset.empty = 'false'
      el.innerHTML = ''
    }
    const node = document.createElement('div')
    node.className = 'evt'
    node.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`
    el.prepend(node)
    try{ el.scrollTop = 0 }catch(error){}
    while(el.children.length>80) el.removeChild(el.lastChild)
  }

  const handleClearEvents = useCallback(() => {
    const el = eventsRef.current
    if(!el) return
    el.innerHTML = ''
    el.dataset.empty = 'true'
    const placeholder = document.createElement('div')
    placeholder.className = 'events-empty'
    placeholder.innerText = 'No events yet. Activity will appear here.'
    el.appendChild(placeholder)
  }, [])

  const tradeSummary = useMemo(() => {
    const summary = {
      openTrades: [],
      latestOpenTrade: null,
      lastClosedTrade: null,
      counts: { open: 0, closed: 0, other: 0, total: 0 }
    }
    for (const trade of trades){
      const statusKey = mapStatus(trade.status)
      summary.counts[statusKey] = (summary.counts[statusKey] || 0) + 1
      summary.counts.total += 1
      if(statusKey === 'open'){
        summary.openTrades.push(trade)
        if(!summary.latestOpenTrade){
          summary.latestOpenTrade = trade
        }
      }else if(statusKey === 'closed' && !summary.lastClosedTrade){
        summary.lastClosedTrade = trade
      }
    }
    return summary
  }, [trades])

  const { openTrades, latestOpenTrade, lastClosedTrade, counts } = tradeSummary
  const positionPnL = latestOpenTrade ? calculatePnL(latestOpenTrade) : null

  const positionMetrics = useMemo(() => {
    if(!latestOpenTrade) return null
    const rawSize = Number(latestOpenTrade.size)
    const rawEntryPrice = Number(latestOpenTrade.price)
    const livePrice = Number(currentPrices[latestOpenTrade.symbol])
    const storedSizeUsd = Number(latestOpenTrade.size_usd)
    const storedLeverage = Number(latestOpenTrade.leverage)

    const sizeValue = Number.isFinite(rawSize) ? rawSize : null
    const entryPrice = Number.isFinite(rawEntryPrice) ? rawEntryPrice : null
    const currentPrice = Number.isFinite(livePrice) && livePrice > 0 ? livePrice : entryPrice
    const notionalFromDb = Number.isFinite(storedSizeUsd) ? storedSizeUsd : null
    const derivedNotional = sizeValue !== null && entryPrice !== null ? sizeValue * entryPrice : null
    const notional = notionalFromDb !== null ? notionalFromDb : derivedNotional

    const leverageFromTrade = Number.isFinite(storedLeverage) && storedLeverage > 0 ? storedLeverage : null
    const leverageFallback = Number.isFinite(DEFAULT_LEVERAGE_FALLBACK) && DEFAULT_LEVERAGE_FALLBACK > 0 ? DEFAULT_LEVERAGE_FALLBACK : null
    const leverageValue = leverageFromTrade ?? leverageFallback ?? null

    let margin = null
    if (isFiniteNumber(latestOpenTrade.margin)) {
      margin = Number(latestOpenTrade.margin)
    } else if (notional !== null && leverageValue) {
      margin = notional / leverageValue
    }

    const totalValue = (sizeValue !== null && currentPrice !== null)
      ? sizeValue * currentPrice
      : (notional !== null ? notional : null)

    let liquidationPrice = null
    if (isFiniteNumber(latestOpenTrade.liquidation_price)) {
      liquidationPrice = Number(latestOpenTrade.liquidation_price)
    } else if (isFiniteNumber(latestOpenTrade.liquidationPrice)) {
      liquidationPrice = Number(latestOpenTrade.liquidationPrice)
    }

    return {
      sizeValue,
      entryPrice,
      currentPrice,
      totalValue,
      leverage: leverageValue,
      margin,
      notional,
      liquidationPrice
    }
  }, [latestOpenTrade, currentPrices])

  const positionOverview = useMemo(() => {
    if (!latestOpenTrade || !positionMetrics) return []
    const baseSymbol = (latestOpenTrade.symbol || '').split(/[_:.]/)[0] || latestOpenTrade.symbol || '—'
    const sizeDisplay = positionMetrics.sizeValue !== null ? `${formatNumber(positionMetrics.sizeValue, 4)} ${baseSymbol}` : '—'
    const sizeUsdDisplay = positionMetrics.totalValue !== null
      ? formatCurrency(positionMetrics.totalValue)
      : positionMetrics.notional !== null
        ? formatCurrency(positionMetrics.notional)
        : '—'
    const leverageDisplay = formatLeverage(positionMetrics.leverage)
    const totalDisplay = formatCurrency(positionMetrics.totalValue ?? positionMetrics.notional)
    const marginDisplay = positionMetrics.margin !== null && isFiniteNumber(positionMetrics.margin)
      ? formatCurrency(positionMetrics.margin)
      : '—'
    const entryDisplay = formatCurrency(positionMetrics.entryPrice)
    const markDisplay = formatCurrency(positionMetrics.currentPrice)
    const pnlDisplay = positionPnL !== null && isFiniteNumber(positionPnL) ? formatCurrency(positionPnL) : '—'

    const liquidationDisplay = positionMetrics.liquidationPrice !== null && isFiniteNumber(positionMetrics.liquidationPrice)
      ? formatCurrency(positionMetrics.liquidationPrice)
      : '—'

    return {
      sizeDisplay,
      leverageDisplay,
      totalDisplay,
      marginDisplay,
      entryDisplay,
      markDisplay,
      pnlDisplay,
  sizeUsdDisplay,
  liquidationDisplay,
      hasMargin: positionMetrics.margin !== null && isFiniteNumber(positionMetrics.margin),
      hasLeverage: !!positionMetrics.leverage,
      hasTotal: positionMetrics.totalValue !== null,
      sideDisplay: `${(latestOpenTrade.signal || '').toUpperCase()} ${baseSymbol}`,
      sideTone: latestOpenTrade.signal?.toUpperCase() === 'BUY' ? 'long' : 'short',
      pnlTone: positionPnL > 0 ? 'positive' : positionPnL < 0 ? 'negative' : 'neutral'
    }
  }, [latestOpenTrade, positionMetrics, formatNumber, formatLeverage, formatCurrency, positionPnL])

  async function handleLogin(e){
    e?.preventDefault?.()
    if(!loginUsername || !loginPassword){
      setLoginError('Username and password are required')
      return
    }
    setLoginLoading(true)
    setLoginError('')
    try{
      const res = await fetch(buildApiUrl('/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername.trim(), password: loginPassword })
      })
      if(!res.ok){
        throw new Error('Invalid credentials')
      }
      const data = await res.json()
      localStorage.setItem(STORAGE_TOKEN_KEY, data.access_token)
      localStorage.setItem(STORAGE_ROLE_KEY, data.role)
      setRole(data.role)
      setToken(data.access_token)
      setLoginPassword('')
      setAuthChecked(true)
    }catch(error){
      console.error('[auth] login failed', error)
      setLoginError(error.message || 'Login failed')
    }finally{
      setLoginLoading(false)
    }
  }

  if(!authChecked){
    return (
      <div className="auth-wrapper">
        <div className="auth-card">
          <h2>Checking session</h2>
        </div>
      </div>
    )
  }

  if(!token){
    return (
      <div className="auth-wrapper">
        <form className="auth-card" onSubmit={handleLogin}>
          <h2>CAPI Dashboard Login</h2>
          {loginError && <div className="auth-error">{loginError}</div>}
          <input
            placeholder="Username"
            value={loginUsername}
            onChange={e=>setLoginUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            placeholder="Password"
            type="password"
            value={loginPassword}
            onChange={e=>setLoginPassword(e.target.value)}
            autoComplete="current-password"
          />
          <button type="submit" disabled={loginLoading}>{loginLoading ? 'Signing in' : 'Sign In'}</button>
          <div className="auth-meta">Use your assigned credentials to continue.</div>
        </form>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">CAPI Dashboard</div>
        <div className="header-actions">
          <div className={`status-chip status-${status.toLowerCase()}`}>{status}</div>
          <div className="user-info">
            <span className="role-pill">{role || 'user'}</span>
            <button type="button" onClick={handleLogout}>Logout</button>
          </div>
        </div>
      </header>
      <main className="dashboard-layout">
        <section className="dashboard-primary">
          <div className="metric-grid">
            <div className="metric-card">
              <span className="metric-label">Open</span>
              <span className="metric-value">{counts.open}</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Closed</span>
              <span className="metric-value">{counts.closed}</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Other</span>
              <span className="metric-value">{counts.other}</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Total</span>
              <span className="metric-value">{counts.total}</span>
            </div>
          </div>

          <div className="card current-position-card">
            <div className="card-heading">
              <h3>Current Position</h3>
              {latestOpenTrade && (
                <span className={`position-side-pill ${latestOpenTrade.signal?.toUpperCase() === 'BUY' ? 'long' : 'short'}`}>
                  {latestOpenTrade.signal}
                </span>
              )}
            </div>
            {latestOpenTrade ? (
              <div className="position-content">
                <div className="position-header">
                  <div>
                    <div className="position-symbol">{latestOpenTrade.symbol}</div>
                    <div className="muted">Opened {new Date(latestOpenTrade.created_at*1000).toLocaleString()}</div>
                  </div>
                  <div className="position-price">Entry {formatCurrency(positionMetrics?.entryPrice)}</div>
                </div>
                <div className="position-hero">
                    <div className="position-hero-main">
                    <div className={`side-badge badge-${positionOverview.sideTone}`}>
                      {(latestOpenTrade.signal || '').toUpperCase()}
                    </div>
                    <div className="hero-symbol">{latestOpenTrade.symbol}</div>
                      <div className="hero-size">{positionOverview.sizeDisplay}</div>
                      <div className="hero-size hero-size-usd">{positionOverview.sizeUsdDisplay}</div>
                  </div>
                  <div className="hero-stats">
                    <div className={`hero-stat total ${positionOverview.pnlTone}`}>
                      <span className="stat-label">Total Value</span>
                      <span className="stat-value">{positionOverview.totalDisplay}</span>
                    </div>
                    <div className={`hero-stat ${positionOverview.hasLeverage ? '' : 'stat-missing'}`}>
                      <span className="stat-label">Leverage</span>
                      <span className="stat-value">{positionOverview.leverageDisplay}</span>
                    </div>
                    <div className={`hero-stat ${positionOverview.hasMargin ? '' : 'stat-missing'}`}>
                      <span className="stat-label">Margin</span>
                      <span className="stat-value">{positionOverview.marginDisplay}</span>
                    </div>
                    <div className="hero-stat">
                      <span className="stat-label">Entry</span>
                      <span className="stat-value">{positionOverview.entryDisplay}</span>
                    </div>
                    <div className="hero-stat">
                      <span className="stat-label">Mark</span>
                      <span className="stat-value">{positionOverview.markDisplay}</span>
                    </div>
                    <div className={`hero-stat pnl ${positionOverview.pnlTone}`}>
                      <span className="stat-label">PnL</span>
                      <span className="stat-value">{positionOverview.pnlDisplay}</span>
                    </div>
                    <div className="hero-stat liquidation">
                      <span className="stat-label">Liq. Price</span>
                      <span className="stat-value">{positionOverview.liquidationDisplay}</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="empty-state">No open position. When a new TradingView alert arrives, the previous position is closed automatically and the latest trade appears here.</div>
            )}
          </div>

          {lastClosedTrade && (
            <div className="card previous-position-card">
              <div className="card-heading"><h3>Previous Position</h3></div>
              <div className="position-content">
                <div className="position-header">
                  <div>
                    <div className="position-symbol">{lastClosedTrade.symbol}</div>
                    <div className="muted">Closed {new Date(lastClosedTrade.created_at*1000).toLocaleString()}</div>
                  </div>
                  <div className="position-price status-closed">{String(lastClosedTrade.status || '').toUpperCase()}</div>
                </div>
                <div className="position-metric-grid compact">
                  <div className="position-metric">
                    <span className="label">Size</span>
                    <span className="value">{formatNumber(lastClosedTrade.size, 4)}</span>
                  </div>
                  <div className="position-metric">
                    <span className="label">Exit Price</span>
                    <span className="value">{formatCurrency(lastClosedTrade.price)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          <TradeTable items={trades} onRefresh={fetchTrades} />
        </section>

        <aside className="dashboard-secondary">
          <div className="card status-card">
            <div className="card-heading">
              <h3>Live Status</h3>
              <button type="button" className="link-button" onClick={fetchTrades}>Refresh</button>
            </div>
            <div className="status-summary">
              <div className={`status-chip status-${status.toLowerCase()}`}>{status}</div>
              <div className="status-metric">
                <span className="label">Open Trades</span>
                <span className="value">{counts.open}</span>
              </div>
              <div className="status-metric">
                <span className="label">Symbols Tracked</span>
                <span className="value">{[...new Set(openTrades.map(t => t.symbol))].length}</span>
              </div>
            </div>
          </div>

          <div className="card events-card">
            <div className="card-heading">
              <h3>Live Feed</h3>
              <button type="button" className="link-button" onClick={handleClearEvents}>Clear</button>
            </div>
            <div ref={eventsRef} className="eventsList" data-empty="true">
              <div className="events-empty">No events yet. Activity will appear here.</div>
            </div>
          </div>

          {isAdmin && (
            <>
              <div className="card admin-card">
                <div className="card-heading"><h3>Manual Demo Order</h3></div>
                <div className="form-grid">
                  <label className="field">
                    <span className="field-label">TradingView Secret</span>
                    <input placeholder="Secret" type="password" value={formSecret} onChange={e=>setFormSecret(e.target.value)} />
                  </label>
                  <label className="field">
                    <span className="field-label">Symbol</span>
                    <input placeholder="BTCUSDT" value={formSymbol} onChange={e=>setFormSymbol(e.target.value)} />
                  </label>
                  <label className="field">
                    <span className="field-label">Side</span>
                    <select value={formSide} onChange={e=>setFormSide(e.target.value)}>
                      <option>BUY</option>
                      <option>SELL</option>
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">Size (USD)</span>
                    <input placeholder="100" value={formSizeUsd} onChange={e=>setFormSizeUsd(e.target.value)} />
                  </label>
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    disabled={placing}
                    onClick={async () => {
                      setPlacing(true)
                      try{
                        const body = { secret: formSecret, signal: formSide, symbol: formSymbol, size_usd: formSizeUsd }
                        const headers = authHeaders({ 'Content-Type': 'application/json' })
                        if(formSecret) headers['Tradingview-Secret'] = formSecret
                        const res = await fetch(buildApiUrl('/debug/place-test'), { method: 'POST', headers, body: JSON.stringify(body) })
                        if(res.status === 401 || res.status === 403){ handleLogout(); return }
                        let parsed = null
                        try{ parsed = await res.json() }catch(error){ parsed = await res.text() }
                        try{ pushEvent(`[place-test] status=${res.status} resp=${JSON.stringify(parsed)}`) }catch(error){ console.log(error) }
                        setLastOrderResult({ status: res.status, body: parsed })
                        if(res.ok){ fetchTrades() }
                      }catch(error){ pushEvent(`[place-test] error ${error.message || error}`) }
                      finally {
                        setPlacing(false)
                      }
                    }}
                  >
                    {placing ? 'Placing' : 'Place demo order'}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={()=>{ setFormSecret(''); setFormSizeUsd('100'); setFormSymbol('BTCUSDT'); setFormSide('BUY') }}
                  >
                    Reset
                  </button>
                </div>
              </div>

              {lastOrderResult && (
                <div className="card admin-card">
                  <div className="card-heading"><h3>Last Order Result</h3></div>
                  <div className="muted">Status: {lastOrderResult.status}</div>
                  <pre className="scroll-area">{JSON.stringify(lastOrderResult.body,null,2)}</pre>
                  {lastOrderResult.body && lastOrderResult.body.orderId && (
                    <div className="form-actions">
                      <button type="button" className="ghost-button" onClick={()=>{ navigator.clipboard && navigator.clipboard.writeText(lastOrderResult.body.orderId) }}>Copy Order ID</button>
                      <button
                        type="button"
                        onClick={async ()=>{
                          try{
                            setLastOrderQuery({loading:true})
                            const body = { secret: formSecret, orderId: lastOrderResult.body.orderId }
                            const headers = authHeaders({ 'Content-Type': 'application/json' })
                            if(formSecret) headers['Tradingview-Secret'] = formSecret
                            const res = await fetch(buildApiUrl('/debug/order-status'), { method: 'POST', headers, body: JSON.stringify(body) })
                            if(res.status === 401 || res.status === 403){ handleLogout(); return }
                            let parsed = null
                            try{ parsed = await res.json() }catch(error){ parsed = await res.text() }
                            setLastOrderQuery({ loading:false, status: res.status, body: parsed })
                          }catch(error){ setLastOrderQuery({ loading:false, error: String(error) }) }
                        }}
                      >
                        Query Bitget
                      </button>
                    </div>
                  )}
                  {lastOrderQuery && (
                    <div className="query-output">
                      {lastOrderQuery.loading ? (
                        <div className="muted">Querying</div>
                      ) : lastOrderQuery.error ? (
                        <div className="muted">Error: {lastOrderQuery.error}</div>
                      ) : (
                        <pre className="scroll-area">{JSON.stringify(lastOrderQuery.body,null,2)}</pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      </main>
    </div>
  )
}
