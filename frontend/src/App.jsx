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

// Utility functions
const isLocalDev = () => {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname
  const port = window.location.port
  return (host === 'localhost' || host === '127.0.0.1') && (port === '5173' || port === '5174' || port === '3000')
}

const buildApiUrl = (endpoint) => {
  const envBase = import.meta?.env?.VITE_API_URL
  const defaultLocalApi = 'http://127.0.0.1:8000'
  const base = envBase || (isLocalDev() ? defaultLocalApi : window.location.origin)
  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base
  // Force Railway production URL if we're on Railway domain
  if (window.location.hostname.includes('railway.app')) {
    return `https://capi-production-7bf3.up.railway.app${endpoint}`
  }
  return `${normalizedBase}${endpoint}`
}

const buildWsUrl = () => {
  // Force Railway WebSocket URL if we're on Railway domain
  if (window.location.hostname.includes('railway.app')) {
    return `wss://capi-production-7bf3.up.railway.app/ws`
  }

  const envWsBase = import.meta?.env?.VITE_WS_URL
  const envApiBase = import.meta?.env?.VITE_API_URL
  const defaultLocalApi = 'http://127.0.0.1:8000'

  const resolvedBase = envWsBase || envApiBase || (isLocalDev() ? defaultLocalApi : window.location.origin)

  try {
    const url = new URL(resolvedBase)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    }
    url.pathname = '/ws'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch (error) {
    const fallbackHost = resolvedBase || window.location.origin
    const sanitized = fallbackHost.replace(/\/$/, '')
    const explicitProtocol = sanitized.startsWith('https://') ? 'wss://' : sanitized.startsWith('http://') ? 'ws://' : null
    const defaultProtocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss://' : 'ws://'
    const protocol = explicitProtocol || defaultProtocol
    const host = sanitized.replace(/^https?:\/\//, '')
    return `${protocol}${host}/ws`
  }
}

const formatNumber = (value, decimals = 2) => {
  const num = Number(value)
  return Number.isFinite(num) ? num.toFixed(decimals) : '—'
}

const formatLeverage = (value) => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? `${num}x` : '—'
}

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 8,
})

const currencyFormatterEUR = new Intl.NumberFormat('en-EU', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 8,
})

const usdtFormatter = new Intl.NumberFormat('en-US', {
  style: 'decimal',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const isFiniteNumber = (value) => Number.isFinite(Number(value))

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
  const eventsRef = useRef(null)

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
    return Number.isFinite(num) ? currencyFormatter.format(num) : '—'
  }, [])

  const formatUsdt = useCallback((value) => {
    const num = Number(value)
    return Number.isFinite(num) ? `${usdtFormatter.format(num)} USDT` : '—'
  }, [])

  const formatEur = useCallback((value) => {
    const num = Number(value)
    return Number.isFinite(num) ? currencyFormatterEUR.format(num) : '—'
  }, [])

  const formatPercent = useCallback((value) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return '—'
    const normalized = Math.abs(num) < 0.005 && num !== 0 ? 0 : num
    return `${normalized.toFixed(2)}%`
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
      return
    }

    const priceUpdates = {}
    const positionUpdates = {}
    let needsTradeRefresh = false

    for(const symbol of symbols){
      const encodedSymbol = encodeURIComponent(symbol)
      let markOverride

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
              positionUpdates[symbol] = data
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
              positionUpdates[symbol] = { ...failurePayload, found: false }
              if(failurePayload && (failurePayload.reason === 'dry_run' || failurePayload.reason === 'not_configured') && import.meta.env.MODE !== 'development'){
                bitgetDisabledRef.current = true
              } else if(failurePayload.reason !== 'dry_run' && failurePayload.reason !== 'not_configured'){
                // Position not found in Bitget - mark as closed in our system
                needsTradeRefresh = true

                // Immediately close the trade in database if position no longer exists on Bitget
                try {
                  const closeRes = await fetch(buildApiUrl('/bitget/close-position'), {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                      trade_id: openTrades.find(t => t.symbol === symbol)?.id,
                      reason: 'external_close'
                    })
                  })
                  if (closeRes.ok) {
                    console.log(`[bitget] closed position for ${symbol} as it no longer exists on Bitget`)
                  }
                } catch (closeError) {
                  console.error(`[bitget] failed to close position for ${symbol}:`, closeError)
                }
              }
            }
          }else{
            positionUpdates[symbol] = { found: false, reason: `http_${res.status}` }
          }
        }catch(error){
          console.error(`[bitget] position fetch failed for ${symbol}`, error)
          positionUpdates[symbol] = { found: false, reason: 'network_error' }
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
        return prev
      }
      const next = {}
      for(const sym of openSet){
        if(Object.prototype.hasOwnProperty.call(positionUpdates, sym)){
          next[sym] = positionUpdates[sym]
        }else if(Object.prototype.hasOwnProperty.call(prev, sym)){
          next[sym] = prev[sym]
        }else{
          next[sym] = null
        }
      }
      return next
    })

    // If positions were closed externally, refresh trades to update status
    if(needsTradeRefresh){
      setTimeout(() => fetchTrades(), 1000)
    }
  }

  const calculatePnL = useCallback((trade) => {
    if (!trade) return null
    const snapshot = trade.symbol ? bitgetPositions?.[trade.symbol] : null
    if (snapshot && snapshot.found !== false) {
      const livePnLRaw = snapshot.unrealized_pnl ?? snapshot.unrealizedPnl ?? snapshot.upl
      const livePnL = Number(livePnLRaw)
      if (Number.isFinite(livePnL)) {
        return livePnL
      }
    }
    return null
  }, [bitgetPositions])

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

  const handleClosePosition = useCallback(async () => {
    if (!latestOpenTrade || !isAdmin) return

    try {
      const res = await fetch(buildApiUrl('/bitget/close-position'), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          trade_id: latestOpenTrade.id
        })
      })

      if (res.status === 401 || res.status === 403) {
        handleLogout()
        return
      }

      if (res.ok) {
        const result = await res.json()
        pushEvent('Position close initiated. Exit price: ' + (result.exit_price ? '$' + result.exit_price.toFixed(2) : 'pending') + ', PnL: ' + (result.realized_pnl !== undefined ? '$' + result.realized_pnl.toFixed(2) : 'pending'))
        pushEvent(`Hanging orders cancelled and position closed for ${latestOpenTrade.symbol}`)
        // Refresh trades immediately to reflect status change
        fetchTrades()
      } else {
        const errorData = await res.json()
        pushEvent(`Close position failed: ${errorData?.detail || errorData?.message || 'Unknown error'}`)
      }
    } catch (error) {
      console.error('[close position] error', error)
      pushEvent(`Close position failed: ${error.message || error}`)
    }
  }, [latestOpenTrade, isAdmin, authHeaders, buildApiUrl, handleLogout, pushEvent, fetchTrades])

  const positionMetrics = useMemo(() => {
    if (!latestOpenTrade) return null

    const snapshot = latestOpenTrade.symbol ? bitgetPositions?.[latestOpenTrade.symbol] : undefined

    const toNumber = (value) => {
      const num = Number(value)
      return Number.isFinite(num) ? num : null
    }

    // Always get entry price from trade data as primary source
    const tradeEntryPrice = toNumber(latestOpenTrade.price)
    const tradeSize = toNumber(latestOpenTrade.size)

    if (!snapshot || snapshot.found === false) {
      return {
        snapshot: snapshot ?? null,
        hasSnapshot: false,
        failureReason: snapshot?.reason,
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
  }, [latestOpenTrade, bitgetPositions])

  const positionOverview = useMemo(() => {
    if (!latestOpenTrade || !positionMetrics) return null

    const { hasSnapshot } = positionMetrics
    const baseSymbol = (latestOpenTrade.symbol || '').split(/[_:.]/)[0] || latestOpenTrade.symbol || '—'
    const sizeDisplay = hasSnapshot && positionMetrics.sizeValue !== null
      ? `${formatNumber(positionMetrics.sizeValue, 4)} ${baseSymbol}`
      : '—'
    const sizeUsdDisplay = hasSnapshot && positionMetrics.totalValue !== null
      ? formatUsdt(positionMetrics.totalValue)
      : hasSnapshot && positionMetrics.notional !== null && Number.isFinite(positionMetrics.notional)
        ? formatUsdt(positionMetrics.notional)
        : '—'
    const leverageDisplay = hasSnapshot ? formatLeverage(positionMetrics.leverage) : '—'

    const pnlValue = Number(positionPnL)
    const hasPnlValue = Number.isFinite(pnlValue)
    const pnlDisplay = hasSnapshot && hasPnlValue ? formatUsdt(pnlValue) : '—'

    let pnlPercent = null
    if (hasSnapshot && isFiniteNumber(positionMetrics.pnlRatio)) {
      pnlPercent = Number(positionMetrics.pnlRatio)
      if (Number.isFinite(pnlPercent) && Math.abs(pnlPercent) <= 1.5) {
        pnlPercent = pnlPercent * 100
      }
    }
    if (pnlPercent === null && hasSnapshot && hasPnlValue) {
      const basisRaw = Number(positionMetrics.margin ?? positionMetrics.notional)
      if (Number.isFinite(basisRaw) && basisRaw !== 0) {
        pnlPercent = (pnlValue / basisRaw) * 100
      }
    }
    const pnlPercentDisplay = pnlPercent !== null && Number.isFinite(pnlPercent) ? formatPercent(pnlPercent) : '—'

    const pnlEur = hasSnapshot && hasPnlValue && Number.isFinite(usdToEurRate) ? pnlValue * usdToEurRate : null
    const pnlEurDisplay = pnlEur !== null && Number.isFinite(pnlEur) ? formatEur(pnlEur) : '—'

    const marginValue = hasSnapshot ? positionMetrics.margin : null
    const marginDisplay = Number.isFinite(marginValue) ? formatUsdt(marginValue) : '—'
    const marginEurDisplay = Number.isFinite(marginValue) && Number.isFinite(usdToEurRate)
      ? formatEur(marginValue * usdToEurRate)
      : '—'

    const markPriceDisplay = hasSnapshot && positionMetrics.markPrice !== null && isFiniteNumber(positionMetrics.markPrice)
      ? formatCurrency(positionMetrics.markPrice)
      : '—'

    const liquidationDisplay = hasSnapshot && positionMetrics.liquidationPrice !== null && isFiniteNumber(positionMetrics.liquidationPrice)
      ? formatCurrency(positionMetrics.liquidationPrice)
      : '—'

    const pnlTone = hasSnapshot && hasPnlValue
      ? (pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'neutral')
      : 'neutral'

    return {
      hasSnapshot,
      statusMessage: hasSnapshot ? null : (positionMetrics.failureReason ? `Bitget data unavailable (${positionMetrics.failureReason})` : 'Waiting for Bitget data…'),
      sizeDisplay,
      sizeUsdDisplay,
      leverageDisplay,
      pnlDisplay,
      pnlPercentDisplay,
      pnlEurDisplay,
      marginDisplay,
      marginEurDisplay,
      markPriceDisplay,
      liquidationDisplay,
      hasLeverage: hasSnapshot && isFiniteNumber(positionMetrics.leverage) && Number(positionMetrics.leverage) > 0,
      sideTone: (latestOpenTrade.signal || '').toUpperCase() === 'BUY' ? 'long' : 'short',
      pnlTone,
    }
  }, [latestOpenTrade, positionMetrics, formatNumber, formatUsdt, positionPnL, formatPercent, usdToEurRate, formatEur, formatCurrency, formatLeverage])

  const overallPnL = useMemo(() => {
    let unrealized = 0
    let realized = 0
    let hasUnrealized = false
    let hasRealized = false

    for (const trade of trades) {
      const statusKey = mapStatus(trade.status)
      if (statusKey === 'open') {
        const pnl = calculatePnL(trade)
        if (Number.isFinite(pnl)) {
          unrealized += pnl
          hasUnrealized = true
        }
      } else if (statusKey === 'closed') {
        const raw = trade.realized_pnl ?? trade.realizedPnl
        if (raw !== undefined && raw !== null) {
          const val = Number(raw)
          if (Number.isFinite(val)) {
            realized += val
            hasRealized = true
          }
        }
      }
    }

    return { unrealized, realized, hasUnrealized, hasRealized }
  }, [trades, calculatePnL])

  const overallUnrealizedDisplay = overallPnL.hasUnrealized ? formatUsdt(overallPnL.unrealized) : '—'
  const overallRealizedDisplay = overallPnL.hasRealized ? formatUsdt(overallPnL.realized) : '—'
  const overallUnrealizedEurDisplay = overallPnL.hasUnrealized && Number.isFinite(usdToEurRate)
    ? formatEur(overallPnL.unrealized * usdToEurRate)
    : '—'
  const overallRealizedEurDisplay = overallPnL.hasRealized && Number.isFinite(usdToEurRate)
    ? formatEur(overallPnL.realized * usdToEurRate)
    : '—'
  const overallUnrealizedTone = overallPnL.hasUnrealized
    ? (overallPnL.unrealized > 0 ? 'positive' : overallPnL.unrealized < 0 ? 'negative' : 'neutral')
    : 'neutral'
  const overallRealizedTone = overallPnL.hasRealized
    ? (overallPnL.realized > 0 ? 'positive' : overallPnL.realized < 0 ? 'negative' : 'neutral')
    : 'neutral'
  const toneToClass = (tone) => (tone === 'positive' ? 'positive' : tone === 'negative' ? 'negative' : '')

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
          <div className="card overall-pnl-card">
            <div className="card-heading">
              <h3>Overall PnL</h3>
            </div>
            <div className="overall-pnl-grid">
              <div className={`pnl-block ${toneToClass(overallUnrealizedTone)}`}>
                <span className="label">Total Unrealized</span>
                <span className="value">{overallUnrealizedDisplay}</span>
                <span className="subvalue">{overallUnrealizedEurDisplay}</span>
              </div>
              <div className={`pnl-block ${toneToClass(overallRealizedTone)}`}>
                <span className="label">Total Realized</span>
                <span className="value">{overallRealizedDisplay}</span>
                <span className="subvalue">{overallRealizedEurDisplay}</span>
              </div>
            </div>
          </div>

          <div className="card current-position-card">
            <div className="card-heading">
              <h3>Current Position</h3>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {latestOpenTrade && (
                  <span className={`position-side-pill ${latestOpenTrade.signal?.toUpperCase() === 'BUY' ? 'long' : 'short'}`}>
                    {latestOpenTrade.signal}
                  </span>
                )}
                {latestOpenTrade && isAdmin && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={handleClosePosition}
                    style={{ fontSize: '12px', padding: '4px 8px' }}
                  >
                    Close Position
                  </button>
                )}
              </div>
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
                    <div className={`side-badge badge-${positionOverview?.sideTone || (latestOpenTrade.signal?.toUpperCase() === 'BUY' ? 'long' : 'short')}`}>
                      {(latestOpenTrade.signal || '').toUpperCase()}
                    </div>
                    <div className="hero-symbol">{latestOpenTrade.symbol}</div>
                      <div className="hero-size">{positionOverview?.sizeDisplay ?? '—'}</div>
                      <div className="hero-size hero-size-usd">{positionOverview?.sizeUsdDisplay ?? '—'}</div>
                  </div>
                  <div className="hero-stats">
                      <div className={`hero-stat ${positionOverview?.hasLeverage ? '' : 'stat-missing'}`}>
                      <span className="stat-label">Leverage</span>
                      <span className="stat-value">{positionOverview?.leverageDisplay ?? '—'}</span>
                    </div>
                    <div className={`hero-stat pnl ${positionOverview?.pnlTone || 'neutral'}`}>
                      <span className="stat-label">PnL</span>
                      <span className="stat-value">{positionOverview?.pnlDisplay ?? '—'}</span>
                      <span className="stat-subvalue">{positionOverview?.pnlPercentDisplay ?? '—'}</span>
                      <span className="stat-subvalue muted">{positionOverview?.pnlEurDisplay ?? '—'}</span>
                    </div>
                    <div className="hero-stat">
                      <span className="stat-label">Margin</span>
                      <span className="stat-value">{positionOverview?.marginDisplay ?? '—'}</span>
                      <span className="stat-subvalue muted">{positionOverview?.marginEurDisplay ?? '—'}</span>
                    </div>
                    <div className="hero-stat">
                      <span className="stat-label">Mark Price</span>
                      <span className="stat-value">{positionOverview?.markPriceDisplay ?? '—'}</span>
                    </div>
                    <div className="hero-stat liquidation">
                      <span className="stat-label">Liq. Price</span>
                      <span className="stat-value">{positionOverview?.liquidationDisplay ?? '—'}</span>
                    </div>
                  </div>
                </div>
                {positionOverview && positionOverview.hasSnapshot === false && (
                  <div className="muted" style={{ marginTop: '12px' }}>{positionOverview.statusMessage}</div>
                )}
              </div>
            ) : (
              <div className="empty-state">No open position. When a new TradingView alert arrives, the previous position is closed automatically and the latest trade appears here.</div>
            )}
          </div>

          <div className="card graph-card">
            <div className="card-heading graph-heading">
              <h3>Market Graph</h3>
              <span className="muted">BTCUSDT.P • Bitget</span>
            </div>
            <div className="graph-body">
              <TradingViewChart
                symbol="BITGET:BTCUSDT.P"
                positionSignals={latestOpenTrade ? [latestOpenTrade] : []}
              />
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

          <TradeTable
            items={trades}
            onRefresh={fetchTrades}
            calculatePnL={calculatePnL}
            formatCurrency={formatCurrency}
          />
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
