import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TradeTable from './TradeTable'
import TradingViewChart from './TradingViewChart'

const STORAGE_TOKEN_KEY = 'capi_token'
const STORAGE_ROLE_KEY = 'capi_role'

const DEFAULT_LEVERAGE_FALLBACK = (() => {
  try {
    const raw = import.meta?.env?.VITE_DEFAULT_LEVERAGE
    if (raw === undefined || raw === null || raw === '') return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  } catch (error) {
    return null
  }
})()

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const numberFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 })
const usdtFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

const isFiniteNumber = (value) => Number.isFinite(Number(value))
const getPnlTone = (value) => {
  if (value > 0) return 'positive'
  if (value < 0) return 'negative'
  return 'neutral'
}

const WATCH_SYMBOLS = (() => {
  try {
    const rawList = import.meta?.env?.VITE_WATCH_SYMBOLS || import.meta?.env?.VITE_DEFAULT_SYMBOL || ''
    if (!rawList) return []
    return rawList.split(',').map((item) => item.trim()).filter(Boolean)
  } catch (error) {
    return []
  }
})()

const normalizeSymbolKey = (value) => (value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase()
const EM_DASH = '\u2014'
const BULLET = '\u2022'

function App() {
  // State variables
  const [loginUsername, setLoginUsername] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  const [token, setToken] = useState(localStorage.getItem(STORAGE_TOKEN_KEY))
  const [role, setRole] = useState(localStorage.getItem(STORAGE_ROLE_KEY))
  const [authChecked, setAuthChecked] = useState(false)

  const [trades, setTrades] = useState([])
  const [status, setStatus] = useState('Disconnected')
  const [currentPrices, setCurrentPrices] = useState({})
  const [bitgetPositions, setBitgetPositions] = useState({})
  const [usdToEurRate, setUsdToEurRate] = useState(null)

  // Form states for admin
  const [formSecret, setFormSecret] = useState('')
  const [formSymbol, setFormSymbol] = useState('BTCUSDT')
  const [formSide, setFormSide] = useState('BUY')
  const [formSizeUsd, setFormSizeUsd] = useState('100')
  const [placing, setPlacing] = useState(false)
  const [lastOrderResult, setLastOrderResult] = useState(null)
  const [lastOrderQuery, setLastOrderQuery] = useState(null)

  // Refs
  const wsRef = useRef(null)
  const priceIntervalRef = useRef(null)
  const rateIntervalRef = useRef(null)
  const tradesRef = useRef([])
  const bitgetDisabledRef = useRef(false)
  const bitgetPositionsRef = useRef({})
  const eventsRef = useRef(null)

  const isAdmin = role === 'admin'

  const getBitgetSnapshot = useCallback((symbol) => {
    if (!symbol) return null
    const key = normalizeSymbolKey(symbol)
    if (!key) return null
    return bitgetPositionsRef.current?.[key] ?? null
  }, [])

  const handleLogout = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close() } catch (error) {}
      wsRef.current = null
    }
    if (priceIntervalRef.current) {
      clearInterval(priceIntervalRef.current)
      priceIntervalRef.current = null
    }
    if (rateIntervalRef.current) {
      clearInterval(rateIntervalRef.current)
      rateIntervalRef.current = null
    }
    bitgetDisabledRef.current = false

    setStatus('Disconnected')
    setTrades([])
    tradesRef.current = []
    setCurrentPrices({})
    setBitgetPositions({})
    bitgetPositionsRef.current = {}
    setUsdToEurRate(null)
    setLastOrderResult(null)
    setLastOrderQuery(null)
    setPlacing(false)

    setToken('')
    setRole('')
    setLoginUsername('')
    setLoginPassword('')
    setLoginError('')

    localStorage.removeItem(STORAGE_TOKEN_KEY)
    localStorage.removeItem(STORAGE_ROLE_KEY)
    setAuthChecked(false)
  }, [])

  const formatCurrency = useCallback((value) => {
    const num = Number(value)
    return Number.isFinite(num) ? currencyFormatter.format(num) : EM_DASH
  }, [])

  const formatUsdt = useCallback((value) => {
    const num = Number(value)
    return Number.isFinite(num) ? `${usdtFormatter.format(num)} USDT` : EM_DASH
  }, [])

  const formatNumber = useCallback((value, digits = 4) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return '—'
    if (digits !== 4) {
      return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(num)
    }
    return numberFormatter.format(num)
  }, [])

  const buildApiUrl = useCallback((path) => {
    if (typeof window === 'undefined') return path
    const { protocol, host } = window.location
    return `${protocol}//${host}${path}`
  }, [])

  const buildWsUrl = useCallback(() => {
    if (typeof window === 'undefined') return null
    const { protocol, host } = window.location
    const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProtocol}//${host}`
  }, [])

  const isLocalFrontend = useCallback(() => {
    if (typeof window === 'undefined') return false
    const host = window.location.hostname
    const port = window.location.port
    const localHosts = ['localhost', '127.0.0.1']
    const localPorts = ['5173', '5174', '3000']
    return localHosts.includes(host) && (localPorts.includes(port) || port === '')
  }, [])

  const verifyToken = useCallback(async () => {
    if (!token) {
      setAuthChecked(true)
      return
    }
    try {
      const res = await fetch(buildApiUrl('/auth/me'), { headers: authHeaders() })
      if (!res.ok) {
        throw new Error('unauthorized')
      }
      const data = await res.json()
      const userRole = data.role || 'user'
      setRole(userRole)
      localStorage.setItem(STORAGE_TOKEN_KEY, token)
      localStorage.setItem(STORAGE_ROLE_KEY, userRole)
      setAuthChecked(true)
    } catch (error) {
      console.error('[verify] error', error)
      handleLogout()
    }
  }, [token, handleLogout])

  const fetchUsdToEur = useCallback(async () => {
    try {
      const res = await fetch('https://api.exchangerate.host/latest?base=USD&symbols=EUR')
      if (!res.ok) {
        return
      }
      const data = await res.json()
      const rate = Number(data?.rates?.EUR)
      if (Number.isFinite(rate) && rate > 0) {
        setUsdToEurRate(rate)
      }
    } catch (error) {
      console.error('[usd to eur] fetch error', error)
    }
    verifyToken()
  }, [verifyToken])

  useEffect(() => {
    // Check for existing token and verify it
    if (!authChecked) {
      if (token) {
        verifyToken()
      } else {
        setAuthChecked(true)
      }
      return
    }

    if (!token) return

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
  }, [authChecked, token, verifyToken])

  useEffect(() => {
    if (!authChecked || !token) {
      return
    }

    fetchUsdToEur()
    if (rateIntervalRef.current) {
      clearInterval(rateIntervalRef.current)
    }
    rateIntervalRef.current = setInterval(fetchUsdToEur, 15 * 60 * 1000)

    return () => {
      if (rateIntervalRef.current) {
        clearInterval(rateIntervalRef.current)
        rateIntervalRef.current = null
      }
    }
  }, [authChecked, token, fetchUsdToEur])

  async function fetchTrades(){
    if (!token) return
    try{
      const res = await fetch(buildApiUrl('/trades'), { headers: authHeaders() })
      if(res.status === 401 || res.status === 403){
        handleLogout()
        return
      }
      if (!res.ok) {
        // If we get HTML instead of JSON, log it but don't crash
        const text = await res.text()
        if (text.includes('<!doctype') || text.includes('<html')) {
          console.error('[trades] Server returned HTML instead of JSON, likely a backend error')
          setTrades([])
          return
        }
        throw new Error(`HTTP ${res.status}: ${text}`)
      }
      const data = await res.json()
      const sorted = Array.isArray(data) ? [...data].sort((a,b)=>((b?.created_at||0) - (a?.created_at||0))) : []
      setTrades(sorted)
      tradesRef.current = sorted
      await fetchPricesForOpenPositions(sorted)
    }catch(error){
      console.error('[trades] fetch error', error)
      setTrades([])
    }
  }

  async function fetchPricesForOpenPositions(tradesData){
    await updatePricesOnly(tradesData)
  }

  async function updatePricesOnly(tradesData){
    if (!token) return
    const source = Array.isArray(tradesData) ? tradesData : (Array.isArray(tradesRef.current) ? tradesRef.current : [])
    const openTrades = source.filter(t => mapStatus(t.status) === 'open')
    const openSymbols = openTrades.map(t => t.symbol).filter(Boolean)
    const historicalSymbols = source.map(t => t.symbol).filter(Boolean)

    const symbolSet = new Set()
    for (const sym of openSymbols) symbolSet.add(sym)
    for (const sym of historicalSymbols) symbolSet.add(sym)
    for (const sym of WATCH_SYMBOLS) symbolSet.add(sym)

    const symbols = Array.from(symbolSet).filter(Boolean)
    if(symbols.length === 0){
      setCurrentPrices({})
      setBitgetPositions({})
      bitgetPositionsRef.current = {}
      return
    }

    const priceUpdates = {}
    const positionUpdates = {}
    const normalizedKeysSet = new Set()
    let needsTradeRefresh = false

    for(const symbol of symbols){
      const normalizedKey = normalizeSymbolKey(symbol)
      if(normalizedKey){
        normalizedKeysSet.add(normalizedKey)
      }
      const encodedSymbol = encodeURIComponent(symbol)
      let markOverride
      const previousEntry = normalizedKey ? bitgetPositionsRef.current?.[normalizedKey] : undefined

      if(!bitgetDisabledRef.current){
        try{
          const res = await fetch(buildApiUrl(`/bitget/position/${encodedSymbol}`), { headers: authHeaders() })
          if(res.status === 401 || res.status === 403){
            handleLogout()
            return
          }
          if(res.ok){
            const data = await res.json()
            if(data && data.found){
              if(normalizedKey){
                positionUpdates[normalizedKey] = {
                  ...data,
                  symbolKey: normalizedKey,
                  requested_symbol: data.requested_symbol || symbol,
                }
              }
              console.log('[bitget] position data:', data)
              const markCandidate = Number(data.mark_price ?? data.markPrice)
              if(Number.isFinite(markCandidate)){
                markOverride = markCandidate
              } else {
                const markFallback = Number(data.index_price ?? data.indexPrice)
                if(Number.isFinite(markFallback)){
                  markOverride = markFallback
                }
              }
            }else{
              console.log('[bitget] position not found or failed:', data)
              const failurePayload = data && typeof data === 'object' ? data : { found: false, reason: 'unavailable' }
              const failureReason = typeof failurePayload?.reason === 'string' ? failurePayload.reason : ''
              if(normalizedKey){
                positionUpdates[normalizedKey] = {
                  ...failurePayload,
                  found: false,
                  symbolKey: normalizedKey,
                  requested_symbol: failurePayload?.requested_symbol || symbol,
                }
              }
              if(failureReason && (failureReason === 'dry_run' || failureReason === 'not_configured') && import.meta.env.MODE !== 'development'){
                bitgetDisabledRef.current = true
              } else if(normalizedKey && (failureReason === 'not_found' || failureReason === 'empty')){
                const previouslyFound = previousEntry?.found !== false && previousEntry !== null && previousEntry !== undefined
                if(previouslyFound){
                  // Position was previously found but now missing - mark as closed in our system
                  needsTradeRefresh = true

                  const matchingTrade = openTrades.find((t) => normalizeSymbolKey(t.symbol) === normalizedKey)
                  if(matchingTrade?.id){
                    try {
                      const closeRes = await fetch(buildApiUrl('/bitget/close-position'), {
                        method: 'POST',
                        headers: authHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify({
                          trade_id: matchingTrade.id,
                          reason: 'external_close'
                        })
                      })
                      if (closeRes.ok) {
                        console.log(`[bitget] closed position for ${symbol} after Bitget reported it missing`)
                      }
                    } catch (closeError) {
                      console.error(`[bitget] failed to close position for ${symbol}:`, closeError)
                    }
                  }
                } else {
                  // Likely a fresh trade still being acknowledged by Bitget
                  console.log(`[bitget] awaiting position availability for ${symbol} (Bitget returned ${failureReason})`)
                }
              }
            }
          }else if(normalizedKey){
            positionUpdates[normalizedKey] = {
              found: false,
              reason: `http_${res.status}`,
              symbolKey: normalizedKey,
              requested_symbol: symbol,
            }
          }
        }catch(error){
          console.error(`[bitget] position fetch failed for ${symbol}`, error)
          if(normalizedKey){
            positionUpdates[normalizedKey] = {
              found: false,
              reason: 'network_error',
              symbolKey: normalizedKey,
              requested_symbol: symbol,
            }
          }
        }
      }

      if(!Number.isFinite(markOverride)){
        try{
          const res = await fetch(buildApiUrl(`/price/${encodedSymbol}`), { headers: authHeaders() })
          if(res.status === 401 || res.status === 403){
            handleLogout()
            return
          }
          const data = await res.json()
          if(data && data.price !== undefined && data.price !== null){
            const priceValue = Number(data.price)
            if(Number.isFinite(priceValue)){
              priceUpdates[symbol] = priceValue
            }
          }
        }catch(error){
          console.error(`[price] failed for ${symbol}`, error)
        }
      }else{
        priceUpdates[symbol] = markOverride
      }
    }

    const openSet = new Set(symbols)
    const normalizedKeys = Array.from(normalizedKeysSet)

    setCurrentPrices(prev => {
      const next = {}
      for(const sym of openSet){
        if(Object.prototype.hasOwnProperty.call(priceUpdates, sym)){
          next[sym] = priceUpdates[sym]
        }else if(prev[sym] !== undefined){
          next[sym] = prev[sym]
        }
      }
      return next
    })

    setBitgetPositions(prev => {
      if(bitgetDisabledRef.current){
        bitgetPositionsRef.current = prev
        return prev
      }
      const next = {}
      for(const key of normalizedKeys){
        if(Object.prototype.hasOwnProperty.call(positionUpdates, key)){
          next[key] = positionUpdates[key]
        }else if(Object.prototype.hasOwnProperty.call(prev, key)){
          next[key] = prev[key]
        }else{
          next[key] = null
        }
      }
      bitgetPositionsRef.current = next
      return next
    })

    // If positions were closed externally, refresh trades to update status
    if(needsTradeRefresh){
      setTimeout(() => fetchTrades(), 1000)
    }
  }

  function calculatePnL(trade, prices = currentPrices){
    const currentPrice = Number(prices[trade.symbol])
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
      setStatus('Disconnected')
      return
    }
    try {
      const socket = new WebSocket(`${wsBase}?token=${encodeURIComponent(token)}`)
      wsRef.current = socket

      socket.onopen = () => {
        setStatus('Connected')
        console.log('[ws] WebSocket connected')
      }

      socket.onclose = (event) => {
        console.log('[ws] WebSocket closed, code:', event.code, 'reason:', event.reason)
        setStatus('Disconnected')
        wsRef.current = null
        if(event && event.code === 1008){
          console.log('[ws] Authentication failed, logging out')
          pushEvent('WebSocket authentication failed; logging out.')
          handleLogout()
        }else if(token){
          // Auto-reconnect after delay
          setTimeout(()=>{
            if(token && !wsRef.current){
              console.log('[ws] Attempting reconnection')
              connectWS()
            }
          }, 3000)
        }
      }

      socket.onmessage = (event)=>{
        try{
          const payload = JSON.parse(event.data)
          console.log('[ws] Received message:', payload.type)
          if(['received','placed','error','ignored','closed'].includes(payload.type)) {
            fetchTrades()
          }
        }catch(error){
          console.error('[ws] message parse error', error)
        }
      }

      socket.onerror = (error) => {
        console.error('[ws] WebSocket error:', error)
        setStatus('Error')
      }

    } catch (error) {
      console.error('[ws] Failed to create WebSocket:', error)
      setStatus('Error')
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

  // Calculate total PnL metrics
  const totalUnrealizedPnL = trades
    .filter(t => mapStatus(t.status) === 'open')
    .map(t => calculatePnL(t))
    .filter(pnl => pnl !== null)
    .reduce((sum, pnl) => sum + pnl, 0)

  const totalRealizedPnL = trades
    .filter(t => mapStatus(t.status) === 'closed')
    .map(t => calculatePnL(t))
    .filter(pnl => pnl !== null)
    .reduce((sum, pnl) => sum + pnl, 0)

  const totalPnL = totalUnrealizedPnL + totalRealizedPnL

  const positionMetrics = useMemo(() => {
    if (!latestOpenTrade) return null

    const snapshot = getBitgetSnapshot(latestOpenTrade.symbol)

    const toNumber = (value) => {
      const num = Number(value)
      return Number.isFinite(num) ? num : null
    }

    const tradeEntryPrice = toNumber(latestOpenTrade.price)
    const tradeSize = toNumber(latestOpenTrade.size)

    const hasSnapshot = !!snapshot && snapshot.found !== false
    const failureReason = hasSnapshot ? null : snapshot?.reason

    if (!hasSnapshot) {
      return {
        snapshot: snapshot ?? null,
        hasSnapshot: false,
        failureReason,
        sizeValue: tradeSize,
        entryPrice: tradeEntryPrice,
        markPrice: null,
        totalValue: null,
        leverage: null,
        margin: null,
        notional: null,
        liquidationPrice: null,
        pnlRatio: null,
        unrealizedPnl: null,
      }
    }

    const sizeValue = toNumber(snapshot.size ?? snapshot.signed_size ?? snapshot.hold_vol ?? snapshot.holdVol) ?? tradeSize
    const entryPrice = toNumber(snapshot.avg_open_price ?? snapshot.avgOpenPrice ?? snapshot.entry_price ?? snapshot.entryPrice) ?? tradeEntryPrice
    const markPrice = toNumber(snapshot.mark_price ?? snapshot.markPrice ?? snapshot.index_price ?? snapshot.indexPrice)
    const margin = toNumber(snapshot.margin ?? snapshot.margin_usd ?? snapshot.marginUsd ?? snapshot.marginSize ?? snapshot.positionMargin)
    const leverage = toNumber(snapshot.leverage ?? snapshot.leverageCross ?? snapshot.leverage_multi ?? snapshot.leverageMulti ?? snapshot.marginLeverage)
    const notional = (() => {
      const explicit = toNumber(snapshot.notional ?? snapshot.size_usd ?? snapshot.sizeUsd ?? snapshot.positionValue ?? snapshot.positionValueUsd)
      if (explicit !== null) return explicit
      if (sizeValue !== null && entryPrice !== null) return sizeValue * entryPrice
      if (sizeValue !== null && markPrice !== null) return sizeValue * markPrice
      return null
    })()
    const liquidationPrice = toNumber(snapshot.liquidation_price ?? snapshot.liquidationPrice ?? snapshot.liq_price ?? snapshot.liqPrice ?? snapshot.liquidationPx)
    const pnlRatio = toNumber(snapshot.pnl_ratio ?? snapshot.pnlRatio ?? snapshot.uplRatio ?? snapshot.uplRate ?? snapshot.roe ?? snapshot.unrealizedPLRatio)
    const unrealizedPnl = toNumber(snapshot.unrealized_pnl ?? snapshot.unrealizedPnl ?? snapshot.upl ?? snapshot.unrealizedPL)

    const totalValue = notional !== null
      ? notional
      : (sizeValue !== null && markPrice !== null ? sizeValue * markPrice : null)

    return {
      snapshot,
      hasSnapshot: true,
      failureReason: null,
      sizeValue,
      entryPrice,
      markPrice,
      totalValue,
      leverage,
      margin,
      notional,
      liquidationPrice,
      pnlRatio,
      unrealizedPnl,
    }
  }, [latestOpenTrade, getBitgetSnapshot])

  const positionOverview = useMemo(() => {
    if (!latestOpenTrade || !positionMetrics) return null
    const baseSymbol = (latestOpenTrade.symbol || '').split(/[_:.]/)[0] || latestOpenTrade.symbol || '—'
    const sizeDisplay = positionMetrics.sizeValue !== null ? `${formatNumber(positionMetrics.sizeValue)} ${baseSymbol}` : '—'
    const sizeUsdDisplay = positionMetrics.totalValue !== null
      ? formatCurrency(positionMetrics.totalValue)
      : positionMetrics.notional !== null
        ? formatCurrency(positionMetrics.notional)
        : '—'
    const totalDisplay = formatCurrency(positionMetrics.totalValue ?? positionMetrics.notional)
    const markDisplay = formatCurrency(positionMetrics.markPrice ?? positionMetrics.currentPrice)
    const pnlDisplay = positionPnL !== null && isFiniteNumber(positionPnL) ? formatCurrency(positionPnL) : '—'

    return {
      hasSnapshot: positionMetrics.hasSnapshot,
      statusMessage: positionMetrics.hasSnapshot ? 'Live' : 'Offline',
      sizeDisplay,
      totalDisplay,
      markDisplay,
      pnlDisplay,
      sideDisplay: `${(latestOpenTrade.signal || '').toUpperCase()} ${baseSymbol}`,
      sideTone: latestOpenTrade.signal?.toUpperCase() === 'BUY' ? 'long' : 'short',
      pnlTone: positionPnL > 0 ? 'positive' : positionPnL < 0 ? 'negative' : 'neutral'
    }
  }, [latestOpenTrade, positionMetrics, formatNumber, formatCurrency, positionPnL])

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
          <div className="metric-grid pnl-grid">
            <div className="metric-card pnl-card">
              <span className="metric-label">Total Unrealized</span>
              <span className={`metric-value pnl-value ${getPnlTone(totalUnrealizedPnL)}`}>{formatCurrency(totalUnrealizedPnL)}</span>
            </div>
            <div className="metric-card pnl-card">
              <span className="metric-label">Total Realized</span>
              <span className={`metric-value pnl-value ${getPnlTone(totalRealizedPnL)}`}>{formatCurrency(totalRealizedPnL)}</span>
            </div>
          </div>

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
                  {isAdmin && (
                    <button
                      type="button"
                      className="close-position-button"
                      onClick={async () => {
                        try {
                          const res = await fetch(buildApiUrl(`/close/${latestOpenTrade.id}`), {
                            method: 'POST',
                            headers: authHeaders()
                          })
                          if (res.ok) {
                            pushEvent(`Position closed successfully`)
                            fetchTrades()
                          } else {
                            pushEvent(`Failed to close position: ${res.status}`)
                          }
                        } catch (error) {
                          pushEvent(`Error closing position: ${error.message}`)
                        }
                      }}
                    >
                      Close Position
                    </button>
                  )}
                </div>
                <div className="position-hero">
                    <div className="position-hero-main">
                    <div className={`side-badge badge-${positionOverview.sideTone || 'neutral'}`}>
                      {(latestOpenTrade.signal || '').toUpperCase()}
                    </div>
                    <div className="hero-symbol">{latestOpenTrade.symbol}</div>
                      <div className="hero-size">{positionOverview.sizeDisplay}</div>
                      <div className="hero-size hero-size-usd">{positionOverview.sizeUsdDisplay}</div>
                  </div>
                  <div className="hero-stats">
                    <div className={`hero-stat total ${positionOverview.pnlTone || 'neutral'}`}>
                      <span className="stat-label">Total Value</span>
                      <span className="stat-value">{positionOverview.totalDisplay}</span>
                    </div>
                    <div className="hero-stat">
                      <span className="stat-label">Mark</span>
                      <span className="stat-value">{positionOverview.markDisplay}</span>
                    </div>
                    <div className={`hero-stat pnl ${positionOverview.pnlTone || 'neutral'}`}>
                      <span className="stat-label">PnL</span>
                      <span className="stat-value">{positionOverview.pnlDisplay}</span>
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

          <TradingViewChart latestOpenTrade={latestOpenTrade} />

          <TradeTable items={trades} onRefresh={fetchTrades} calculatePnL={calculatePnL} formatCurrency={formatCurrency} currentPrices={currentPrices} />
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
                        if(res.status === 401){ handleLogout(); return }
                        let parsed = null
                        const text = await res.text()
                        let parsedResponse = null
                        try{ parsedResponse = JSON.parse(text) }catch(error){ parsedResponse = { raw_response: text } }
                        try{ pushEvent(`[place-test] status=${res.status} resp=${JSON.stringify(parsedResponse)}`) }catch(error){ console.log(error) }
                        setLastOrderResult({ status: res.status, body: parsedResponse })
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
                            if(res.status === 401){ handleLogout(); return }
                            const text = await res.text()
                            let parsed = null
                            try{ parsed = JSON.parse(text) }catch(error){ parsed = { raw_response: text } }
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

export default App







