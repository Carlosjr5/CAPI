import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TradeTable from './TradeTable'
import TradingViewChart from './TradingViewChart'
import PnlChart from './PnlChart'

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
const normalizeSymbolForApi = (value) => {
  if (!value) return value
  return value
    .replace(/^BINANCE:/i, '')
    .replace(/\.P$/i, '')
    .replace(/[^A-Z0-9_]/gi, '')
}
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
  const [isMobile, setIsMobile] = useState(false)

  // Form states for admin
  const [formSecret, setFormSecret] = useState('')
  const [formSymbol, setFormSymbol] = useState('BTCUSDT')
  const [formSide, setFormSide] = useState('LONG')
  const [formSizeUsd, setFormSizeUsd] = useState('100')
  const [placing, setPlacing] = useState(false)
  const [lastOrderResult, setLastOrderResult] = useState(null)
  const [lastOrderQuery, setLastOrderQuery] = useState(null)

  const [selectedChartSymbol, setSelectedChartSymbol] = useState('BTC')
  const [sidebarExpanded, setSidebarExpanded] = useState(false)

  // Handle outside click to close sidebar
  useEffect(() => {
    const handleOutsideClick = (event) => {
      if (sidebarExpanded && !event.target.closest('.dashboard-secondary') && !event.target.closest('.sidebar-toggle')) {
        setSidebarExpanded(false)
      }
    }

    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('touchstart', handleOutsideClick)

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('touchstart', handleOutsideClick)
    }
  }, [sidebarExpanded])

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
    return Number.isFinite(num) ? `~${currencyFormatter.format(num)}` : EM_DASH
  }, [])

  const formatCurrencyWithColor = useCallback((value) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return EM_DASH

    const colorClass = num > 0 ? 'positive' : num < 0 ? 'negative' : 'neutral'
    const formatted = `~${currencyFormatter.format(num)}`
    return { value: formatted, className: colorClass }
  }, [])

  const formatCurrencyWithSign = useCallback((value) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return EM_DASH
    const sign = num > 0 ? '+' : num < 0 ? '-' : ''
    return `${sign}~${currencyFormatter.format(Math.abs(num))}`
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

    // For Railway deployment, construct WebSocket URL properly
    if (host.includes('railway.app')) {
      return `${wsProtocol}//${host}/ws`
    }

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

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

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

    // Always add common symbols to check for positions that might exist in Bitget but not in our trades
    const commonSymbols = ['BTCUSDT', 'ETHUSDT']
    for (const sym of commonSymbols) symbolSet.add(sym)

    const symbols = Array.from(symbolSet).filter(Boolean)
    if(symbols.length === 0){
      setCurrentPrices({})
      setBitgetPositions({})
      bitgetPositionsRef.current = {}
      return
    }

    // Fetch all Bitget positions to ensure we capture any positions that exist but aren't tracked in our trades
    try {
      const allPositionsRes = await fetch(buildApiUrl('/bitget/all-positions'), { headers: authHeaders() })
      if (allPositionsRes.ok) {
        const allPositionsData = await allPositionsRes.json()
        if (allPositionsData.positions && Array.isArray(allPositionsData.positions)) {
          // Add symbols from all Bitget positions to ensure they're fetched
          for (const pos of allPositionsData.positions) {
            if (pos.requested_symbol) {
              symbolSet.add(pos.requested_symbol)
            } else if (pos.bitget_symbol) {
              // Try to extract base symbol from bitget_symbol (e.g., BTCUSDT from BTCUSDT_UMCBL)
              const baseSymbol = pos.bitget_symbol.split('_')[0]
              if (baseSymbol) symbolSet.add(baseSymbol)
            }
          }
        }
      }
    } catch (error) {
      console.warn('[updatePricesOnly] failed to fetch all Bitget positions:', error)
    }

    const priceUpdates = {}
    const positionUpdates = {}
    const normalizedKeysSet = new Set()
    let needsTradeRefresh = false

    for(const symbol of symbols){
      const normalizedKey = normalizeSymbolKey(symbol)
      const apiSymbol = normalizeSymbolForApi(symbol) || symbol
      if(normalizedKey){
        normalizedKeysSet.add(normalizedKey)
      }
      const encodedSymbol = encodeURIComponent(apiSymbol)
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
                  requested_symbol: symbol,
                }
              }
              console.log('[bitget] position data:', data)
              const markCandidate = Number(data.mark_price ?? data.markPrice)
                            // If a previously found position changed side (e.g., short -> long), close the old trade
                            try {
                              const prevSide = (previousEntry?.side || previousEntry?.positionSide || '').toUpperCase()
                              const newSide = (data.side || data.positionSide || '').toUpperCase()
                              if (previousEntry && previousEntry.found && prevSide && newSide && prevSide !== newSide) {
                                // Attempt to close any open trade for this symbol that has the opposite side
                                const matchingTrade = openTrades.find((t) => normalizeSymbolKey(t.symbol) === normalizedKey && (t.signal || '').toUpperCase() !== newSide)
                                if (matchingTrade?.id) {
                                  needsTradeRefresh = true
                                  try {
                                    const closeRes = await fetch(buildApiUrl('/bitget/close-position'), {
                                      method: 'POST',
                                      headers: authHeaders({ 'Content-Type': 'application/json' }),
                                      body: JSON.stringify({ trade_id: matchingTrade.id, reason: 'external_close' })
                                    })
                                    if (closeRes.ok) {
                                      console.log(`[bitget] closed position for ${symbol} after side change (${prevSide} -> ${newSide})`)
                                      try { fetchTrades() } catch (e) {}
                                    }
                                  } catch (closeError) {
                                    console.error(`[bitget] failed to close position for ${symbol}:`, closeError)
                                  }
                                }
                              }
                            } catch (e) { console.warn('[bitget] side-change reconciliation error', e) }
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
                  requested_symbol: symbol,
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
                        // Fetch trades immediately so UI updates to closed state
                        try { fetchTrades() } catch(e) { /* ignore */ }
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
    if(!trade) return null

    const statusKey = mapStatus(trade.status)
    const entryPrice = Number(trade.price)
    let sizeValue = Number(trade.size)
    // Ensure size value uses absolute magnitude only - direction is handled via `multiplier`.
    if (Number.isFinite(sizeValue)) {
      sizeValue = Math.abs(sizeValue)
    }
    // Determine the directional multiplier based on the trade signal.
    // Keep this consistent with the logic used in `PnlChart` to avoid sign
    // mismatches across the UI. BUY/LONG = 1, SELL/SHORT = -1.
    const upperSignal = trade.signal?.toUpperCase();
    const multiplier = (upperSignal === 'BUY' || upperSignal === 'LONG') ? 1 : (upperSignal === 'SELL' || upperSignal === 'SHORT') ? -1 : 1

    if(!Number.isFinite(sizeValue)){
      const sizeUsd = Number(trade.size_usd ?? trade.sizeUsd)
      if(Number.isFinite(sizeUsd) && Number.isFinite(entryPrice) && entryPrice !== 0){
        sizeValue = sizeUsd / entryPrice
      }
    }

    if(statusKey === 'closed'){
      const realized = Number(trade.realized_pnl ?? trade.realizedPnl)
      if(Number.isFinite(realized)){
        return realized
      }
      const exitPrice = Number(trade.exit_price ?? trade.exitPrice)
      if(Number.isFinite(exitPrice) && Number.isFinite(entryPrice) && Number.isFinite(sizeValue)){
        const r = (exitPrice - entryPrice) * sizeValue * multiplier
        return Number.isFinite(r) ? r : null
      }
      return null
    }

    const currentPrice = Number(prices[trade.symbol])
    if(!Number.isFinite(currentPrice) || !Number.isFinite(entryPrice) || !Number.isFinite(sizeValue)) return null
    const openR = (currentPrice - entryPrice) * sizeValue * multiplier
    return Number.isFinite(openR) ? openR : null
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
      // For Railway deployment, ensure we use the correct WebSocket path
      const wsUrl = wsBase.includes('/ws') ? `${wsBase}?token=${encodeURIComponent(token)}` : `${wsBase}/ws?token=${encodeURIComponent(token)}`
      console.log('[ws] Connecting to:', wsUrl)
      const socket = new WebSocket(wsUrl)
      wsRef.current = socket

      socket.onopen = () => {
        setStatus('Connected')
        console.log('[ws] WebSocket connected')
        // Start sending ping messages every 30 seconds to keep connection alive
        const pingInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(JSON.stringify({ type: 'ping' }))
            } catch (error) {
              console.error('[ws] Failed to send ping:', error)
            }
          } else {
            clearInterval(pingInterval)
          }
        }, 30000)
        socket.pingInterval = pingInterval
      }

      socket.onclose = (event) => {
        console.log('[ws] WebSocket closed, code:', event.code, 'reason:', event.reason)
        setStatus('Disconnected')
        if (socket.pingInterval) {
          clearInterval(socket.pingInterval)
          socket.pingInterval = null
        }
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
          if(['received','placed','error','ignored','closed', 'pong'].includes(payload.type)) {
            // Handle pong or other messages, but pong doesn't trigger fetchTrades
            if(['received','placed','error','ignored','closed'].includes(payload.type)) {
              fetchTrades()
            }

            // Push event to live feed with current position info
            if (payload.type === 'placed' && payload.price) {
              const pnlValue = calculatePnL({ ...payload, signal: payload.signal }, currentPrices)
              let eventText = `${payload.signal} ${payload.symbol} at ${formatCurrency(payload.price)}`

              if (pnlValue !== null) {
                eventText += ` | PnL: ${formatCurrency(pnlValue)}`
                // Add ROE% if we have leverage info
                const margin = payload.margin || (payload.size_usd && payload.leverage ? payload.size_usd / payload.leverage : null)
                if (margin && margin > 0) {
                  const roe = (pnlValue / margin) * 100
                  eventText += ` | ROE: ${roe.toFixed(2)}%`
                }
              }

              pushEvent(eventText)
            } else if (payload.type === 'closed' && payload.realized_pnl !== undefined) {
              let eventText = `Closed position | PnL: ${formatCurrency(payload.realized_pnl)}`

              // Add ROE% for closed positions
              if (payload.margin && payload.margin > 0) {
                const roe = (payload.realized_pnl / payload.margin) * 100
                eventText += ` | ROE: ${roe.toFixed(2)}%`
              }

              pushEvent(eventText)
            }
          }
        }catch(error){
          console.error('[ws] message parse error', error)
        }
      }

      socket.onerror = (error) => {
        console.error('[ws] WebSocket error:', error)
        setStatus('Error')
        if (socket.pingInterval) {
          clearInterval(socket.pingInterval)
          socket.pingInterval = null
        }
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
    // First pass: determine live open trades by symbol and side so we can
    // ignore any incoming signals/received alerts that would duplicate them
    const liveOpenMap = new Map() // normalizedSymbol -> Set of signal sides
    for (const t of trades){
      const statusKey = mapStatus(t.status)
      if (statusKey === 'open'){
        const key = normalizeSymbolKey(t.symbol)
        const side = (t.signal || '').toUpperCase()
        if(!liveOpenMap.has(key)) liveOpenMap.set(key, new Set())
        liveOpenMap.get(key).add(side)
      }
    }

    for (const trade of trades){
      // If this trade is a received/signal alert which would duplicate an
      // existing open position on the same symbol AND same direction, hide it
      const tradeStatusKey = mapStatus(trade.status)
      const isSignalOrReceived = ['signal','received'].includes((trade.status||'').toLowerCase())
      if (isSignalOrReceived && trade.symbol){
        const key = normalizeSymbolKey(trade.symbol)
        const existingSides = liveOpenMap.get(key)
        const mySide = (trade.signal || '').toUpperCase()
        if (existingSides && existingSides.has(mySide)){
          // Skip adding this trade to the UI summary on purpose to avoid
          // duplicate display of an already open same-side trade
          continue
        }
      }
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

  // Compute a filtered list of trades that should be displayed in tables and charts
  // This removes 'received'/'signal' alerts that duplicate an already-open same-side position
  const displayTrades = useMemo(() => {
    const openMap = new Map()
    for (const t of trades){
      const key = normalizeSymbolKey(t.symbol)
      if (!key) continue
      if (mapStatus(t.status) === 'open'){
        const side = (t.signal || '').toUpperCase()
        if(!openMap.has(key)) openMap.set(key, new Set())
        openMap.get(key).add(side)
      }
    }
    return trades.filter(trade => {
      const s = (trade.status || '').toLowerCase()
      if (s === 'received' || s === 'signal'){
        const key = normalizeSymbolKey(trade.symbol)
        const sides = openMap.get(key)
        const mySide = (trade.signal || '').toUpperCase()
        if (sides && sides.has(mySide)){
          return false
        }
      }
      return true
    })
  }, [trades])
  const positionPnL = latestOpenTrade ? calculatePnL(latestOpenTrade) : null

  // Calculate total PnL metrics
  const totalUnrealizedPnL = trades
    .filter(t => mapStatus(t.status) === 'open')
    .map(t => calculatePnL(t))
    .filter(pnl => Number.isFinite(Number(pnl)))
    .reduce((sum, pnl) => sum + pnl, 0)

  const totalRealizedPnL = trades
    .filter(t => mapStatus(t.status) === 'closed')
    .map(t => calculatePnL(t))
    .filter(pnl => Number.isFinite(Number(pnl)))
    .reduce((sum, pnl) => sum + pnl, 0)

  const totalPnL = totalUnrealizedPnL + totalRealizedPnL

  // Calculate total ROI for entire trading history
  const totalMarginUsed = trades.reduce((sum, t) => {
    const normalizedKey = normalizeSymbolKey(t.symbol)
    const bitgetPosition = bitgetPositions[normalizedKey]
    const statusKey = mapStatus(t.status)
    const sizeUsd = Number(t.size_usd ?? t.sizeUsd)

    // For open positions, use Bitget margin if available
    if (statusKey === 'open' && bitgetPosition?.found && bitgetPosition.margin) {
      return sum + parseFloat(bitgetPosition.margin)
    }

    // For closed positions, use stored margin if available
    if (statusKey === 'closed' && t.margin && !isNaN(parseFloat(t.margin))) {
      return sum + parseFloat(t.margin)
    }

    // Calculate margin from size_usd and leverage for any trade missing margin data
    if (Number.isFinite(sizeUsd) && sizeUsd > 0 && DEFAULT_LEVERAGE_FALLBACK) {
      const calculatedMargin = sizeUsd / DEFAULT_LEVERAGE_FALLBACK
      return sum + calculatedMargin
    }

    // Skip trades without margin data
    return sum
  }, 0)

  const totalROI = totalMarginUsed > 0 ? (totalPnL / totalMarginUsed) * 100 : 0

  // Profitable trades statistics (for closed trades)
  const closedTradesForStats = trades.filter(t => mapStatus(t.status) === 'closed')
  const profitableCount = closedTradesForStats.filter(t => {
    try {
      const pnl = calculatePnL(t)
      return Number.isFinite(Number(pnl)) && Number(pnl) > 0
    } catch (e) {
      return false
    }
  }).length
  const closedTotalForStats = closedTradesForStats.length
  const profitablePct = closedTotalForStats > 0 ? Math.round((profitableCount / closedTotalForStats) * 100) : null

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
    const pnlDisplay = positionPnL !== null && isFiniteNumber(positionPnL) ? formatCurrency(positionPnL) : '—'

    return {
      hasSnapshot: positionMetrics.hasSnapshot,
      statusMessage: positionMetrics.hasSnapshot ? 'Live' : 'Offline',
      sizeDisplay,
      sizeUsdDisplay,
      pnlDisplay,
      sideDisplay: `${(latestOpenTrade.signal || '').toUpperCase()} ${baseSymbol}`,
      sideTone: (latestOpenTrade.signal?.toUpperCase() === 'BUY' || latestOpenTrade.signal?.toUpperCase() === 'LONG') ? 'long' : 'short',
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
        <main className={`dashboard-layout ${sidebarExpanded ? 'menu-expanded' : 'menu-collapsed'}`} style={{ width: '100%', maxWidth: '100%' }}>
          {/* Toggle Button for Mobile/Small Screens */}
          {isAdmin && (
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarExpanded(!sidebarExpanded)}
            style={{
              position: 'fixed',
              top: '20px',
              right: '20px',
              zIndex: 1000,
              background: 'rgba(15, 23, 42, 0.9)',
              border: '1px solid rgba(148, 163, 184, 0.3)',
              borderRadius: '8px',
              color: '#e2e8f0',
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              backdropFilter: 'blur(10px)'
            }}
          >
            <span>{sidebarExpanded ? '◁' : '▷'}</span>
            <span>Menu</span>
          </button>
          )}

          {/* Small logout button for non-admin users (visible top-right) */}
          {!isAdmin && (
            <button
              type="button"
              onClick={handleLogout}
              className="logout-button"
              style={{ position: 'fixed', top: '20px', right: '20px', zIndex: 1000 }}
            >
              Logout
            </button>
          )}

          <section className="dashboard-primary" style={{ width: '100%', flex: '1' }}>
            <div className="metric-grid metric-grid-above-chart">
              <div className="metric-card">
                <span className="metric-label">Open</span>
                <span className="metric-value">{counts.open}</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Closed</span>
                <span className="metric-value">{counts.closed}</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Total</span>
                <span className="metric-value">{counts.total}</span>
              </div>
              <div className="metric-card">
                <span className="metric-label">Profitable</span>
                <span className="metric-value">
                  {closedTotalForStats > 0 ? (
                    `${profitableCount}/${closedTotalForStats}${profitablePct !== null ? ` (${profitablePct}%)` : ''}`
                  ) : (
                    '—'
                  )}
                </span>
              </div>
            </div>

            <div className="card overall-pnl-card">
              <div className="overall-pnl-grid">
                <div className="pnl-block">
                  <span className="label">Total Unrealized</span>
                  <span className="value">
                    <span className={totalUnrealizedPnL > 0 ? 'positive' : totalUnrealizedPnL < 0 ? 'negative' : 'neutral'}>
                      {formatCurrencyWithSign(totalUnrealizedPnL)}
                    </span>
                  </span>
                </div>
                <div className="pnl-block">
                  <span className="label">Total Realized</span>
                  <span className="value">
                        <span className={totalRealizedPnL > 0 ? 'positive' : totalRealizedPnL < 0 ? 'negative' : 'neutral'}>
                          {formatCurrencyWithSign(totalRealizedPnL)}
                    </span>
                  </span>
                </div>
                <div className="pnl-block">
                  <span className="label">Total P&L</span>
                  <span className="value">
                        <span className={totalPnL > 0 ? 'positive' : totalPnL < 0 ? 'negative' : 'neutral'}>
                          {formatCurrencyWithSign(totalPnL)}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            <div className={`stack-on-mobile ${isMobile ? 'mobile-force-column' : ''}`}>
              <div className="card graph-card">
                <div className="graph-heading">
                  <h3>Market Structure</h3>
                  <div className="symbol-selector">
                    <div className="toggle-container">
                      <button
                        className={`symbol-toggle ${selectedChartSymbol === 'BTC' ? 'active' : ''}`}
                        onClick={() => setSelectedChartSymbol('BTC')}
                      >
                        BTC
                      </button>
                      <button
                        className={`symbol-toggle ${selectedChartSymbol === 'ETH' ? 'active' : ''}`}
                        onClick={() => setSelectedChartSymbol('ETH')}
                      >
                        ETH
                      </button>
                      <button
                        className={`symbol-toggle ${selectedChartSymbol === 'SOL' ? 'active' : ''}`}
                        onClick={() => setSelectedChartSymbol('SOL')}
                      >
                        SOL
                      </button>
                      <button
                        className={`symbol-toggle ${selectedChartSymbol === 'XRP' ? 'active' : ''}`}
                        onClick={() => setSelectedChartSymbol('XRP')}
                      >
                        XRP
                      </button>
                    </div>
                    <span className="muted">/USDT • TradingView</span>
                  </div>
                </div>
                <div className="graph-body">
                  <TradingViewChart
                    latestOpenTrade={latestOpenTrade}
                    trades={displayTrades}
                    symbol={selectedChartSymbol}
                  />
                </div>
              </div>

              <div className="card pnl-chart-card">
                <div className="chart-body">
                  <PnlChart trades={displayTrades} currentPrices={currentPrices} bitgetPositions={bitgetPositions} totalPnL={totalPnL} />
                </div>
              </div>
            </div>

            <div className="positions-grid" style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '8px' }}>
             {(() => {
               // Create a combined list of trades and Bitget positions
               const combinedPositions = []

               // Add Bitget positions (always add snapshot object — we prefer Bitget snapshot as authoritative)
               Object.entries(bitgetPositions).forEach(([key, position]) => {
                 if (!position?.found) return
                 combinedPositions.push({
                   type: 'bitget-only',
                   symbol: position.requested_symbol || key,
                   bitgetPosition: position,
                   trade: null
                 })
               })

               // Add trades (both with and without Bitget positions) — deduplicate by symbol and keep the earliest (first) open
               const latestOpenByKey = {}
               openTrades.forEach(t => {
                 const key = normalizeSymbolKey(t.symbol)
                 if (!key) return
                 const prev = latestOpenByKey[key]
                 // Keep the earliest (lowest created_at) trade for the symbol to accept the first alert only
                 if (!prev || (t.created_at || 0) < (prev.created_at || 0)) {
                   latestOpenByKey[key] = t
                 }
               })
               Object.values(latestOpenByKey).forEach(trade => {
                 const normalizedKey = normalizeSymbolKey(trade.symbol)
                 const bitgetPosition = bitgetPositions[normalizedKey]
                 const hasSnapshot = bitgetPosition?.found
                 // If Bitget explicitly reports the position as missing, don't render
                 // this trade as an open position (the trade likely was closed externally).
                 if (bitgetPosition && bitgetPosition.found === false) {
                   return
                 }
                // If Bitget snapshot exists, prefer Bitget as authoritative and skip the DB trade so we don't show
                // duplicates in the UI. Also handle side mismatches by closing the DB trade via reconciliation.
                if (hasSnapshot && bitgetPosition?.side) {
                  const bitgetSideUp = (bitgetPosition.side || '').toUpperCase()
                  const tradeSideUp = (trade.signal || '').toUpperCase()
                  if (bitgetSideUp === tradeSideUp) {
                    // Duplicate: Bitget already has same side open — prefer snapshot and skip the DB trade
                    return
                  }
                  if (tradeSideUp && bitgetSideUp !== tradeSideUp) {
                    // Side mismatch — treat the DB trade as stale and skip it (reconciliation will close it)
                    return
                  }
                }

                 combinedPositions.push({
                   type: 'trade',
                   symbol: trade.symbol,
                   trade,
                   bitgetPosition
                 })
               })

               // Sort positions alphabetically by symbol for better organization
               combinedPositions.sort((a, b) => a.symbol.localeCompare(b.symbol))

               // Sort positions by symbol (BTC left, ETH right)
               combinedPositions.sort((a, b) => a.symbol.localeCompare(b.symbol))

               if (combinedPositions.length === 0) {
                 return null;
               }

               return combinedPositions.map(item => {
                 const { type, symbol, trade, bitgetPosition } = item
                 const tradeId = trade?.id || `bitget-${symbol}`
                 const hasSnapshot = bitgetPosition?.found
                 const bitgetSide = bitgetPosition?.side?.toUpperCase()

                 // Debug bitgetPosition data
                 if (bitgetPosition) {
                   console.log(`Position data for ${symbol}:`, bitgetPosition)
                 }

                 let positionPnL = null
                 if (bitgetPosition?.found && bitgetPosition.unrealized_pnl !== null && bitgetPosition.unrealized_pnl !== undefined) {
                   positionPnL = Number(bitgetPosition.unrealized_pnl)
                 } else if (trade) {
                   positionPnL = calculatePnL(trade)
                 }

                 const pnlDisplay = positionPnL !== null && isFiniteNumber(positionPnL) ? formatCurrency(positionPnL) : '—'
                 const pnlTone = positionPnL > 0 ? 'positive' : positionPnL < 0 ? 'negative' : 'neutral'

                 // Build metric tiles explicitly (no Size/Entry). Prefer Bitget snapshot, fallback to live price/leverage hints
                 const metricItems = []
                 const markValue = Number.isFinite(Number(bitgetPosition?.mark_price))
                   ? Number(bitgetPosition.mark_price)
                   : Number.isFinite(Number(currentPrices[symbol]))
                     ? Number(currentPrices[symbol])
                     : null
                 const leverageValue = bitgetPosition?.leverage ?? trade?.leverage ?? null

                 if (markValue !== null) {
                   metricItems.push({ label: 'Mark Price', value: formatCurrency(markValue) })
                 }
                 if (leverageValue !== null && leverageValue !== undefined && leverageValue !== '') {
                   metricItems.push({ label: 'Leverage', value: `${leverageValue}x` })
                 }

                 return (
                   <div key={tradeId} className="card current-position-card">
                     <div className="position-content">
                       <div className="position-hero" style={{ textAlign: 'center', padding: isMobile ? '8px 6px' : '12px 10px' }}>
                         <div className={`side-badge badge-${bitgetSide === 'LONG' ? 'long' : bitgetSide === 'SHORT' ? 'short' : (trade?.signal || '').toUpperCase() === 'LONG' ? 'long' : (trade?.signal || '').toUpperCase() === 'SHORT' ? 'short' : 'long'}`} style={{ margin: isMobile ? '0 auto 12px auto' : '0 auto 20px auto', display: 'block', fontSize: isMobile ? '10px' : '12px', padding: isMobile ? '2px 6px' : '4px 8px' }}>
                           {bitgetSide || (trade?.signal || '').toUpperCase()}
                         </div>
                         <div className="hero-stats" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                           <div className={`hero-stat pnl ${pnlTone}`}>
                             <span className="stat-label">P&L</span>
                             <span className="stat-value">{pnlDisplay}</span>
                           </div>
                           {isAdmin && trade && (
                             <button
                               type="button"
                               className="close-position-button"
                               style={{
                                 background: 'rgba(239, 68, 68, 0.1)',
                                 border: '1px solid rgba(239, 68, 68, 0.3)',
                                 color: '#ef4444',
                                 padding: '6px 12px',
                                 borderRadius: '6px',
                                 cursor: 'pointer',
                                 fontSize: '12px',
                                 fontWeight: '500',
                                 transition: 'all 0.2s ease',
                                 backdropFilter: 'blur(10px)'
                               }}
                               onClick={async () => {
                                 try {
                                   const res = await fetch(buildApiUrl(`/close/${trade.id}`), {
                                     method: 'POST',
                                     headers: authHeaders()
                                   })
                                   if (res.ok) {
                                     pushEvent('Position closed successfully')
                                     fetchTrades()
                                   } else {
                                     pushEvent(`Failed to close position: ${res.status}`)
                                   }
                                 } catch (error) {
                                   pushEvent(`Error closing position: ${error.message}`)
                                 }
                               }}
                             >
                               Close
                             </button>
                           )}
                         </div>
                         {metricItems.length > 0 && (
                           <div className="position-metric-grid compact" style={{ marginTop: '10px', justifyContent: 'center' }}>
                             {metricItems.map((item) => (
                               <div key={item.label} className="position-metric">
                                 <span className="label">{item.label}</span>
                                 <span className="value">{item.value}</span>
                               </div>
                             ))}
                           </div>
                         )}
                         <div className="muted" style={{ marginTop: '6px', fontSize: '11px' }}>
                           {symbol} - {type === 'bitget-only'
                             ? 'Live position from Bitget'
                             : hasSnapshot
                               ? 'Live position from Bitget'
                               : `Opened ${new Date((trade?.created_at || 0)*1000).toLocaleString()}`
                           }
                         </div>
                       </div>
                     </div>
                   </div>
                 )
               })
             })()}
           </div>

           <div className="card trade-history-card">
                  <TradeTable
                    items={displayTrades}
                    onRefresh={fetchTrades}
                    calculatePnL={calculatePnL}
                    formatCurrency={formatCurrency}
                    currentPrices={currentPrices}
                    positionMetrics={positionMetrics}
                    bitgetPositions={bitgetPositions}
                    isAdmin={isAdmin}
                    authHeaders={authHeaders}
                    buildApiUrl={buildApiUrl}
                  />
          </div>
          </section>
  
          {sidebarExpanded && (
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
                      <select value={formSymbol} onChange={e=>setFormSymbol(e.target.value)}>
                        <option value="BTCUSDT">BTC/USDT</option>
                        <option value="ETHUSDT">ETH/USDT</option>
                        <option value="SOLUSDT">SOL/USDT</option>
                        <option value="XRPUSDT">XRP/USDT</option>
                      </select>
                    </label>
                    <label className="field">
                      <span className="field-label">Side</span>
                      <select value={formSide} onChange={e=>setFormSide(e.target.value)}>
                        <option>LONG</option>
                        <option>SHORT</option>
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
                          if (res.ok) {
                            fetchTrades()
                          } else if (res.status === 400 && parsedResponse && (parsedResponse.detail || '').toString().toLowerCase().includes('already have an open')) {
                            // Inform the user via events feed that this test was ignored
                            pushEvent(`[place-test] ignored duplicate ${formSide} for ${formSymbol}: ${parsedResponse.detail}`)
                          }
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
                      onClick={()=>{ setFormSecret(''); setFormSizeUsd('100'); setFormSymbol('BTCUSDT'); setFormSide('LONG') }}
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
            <div className="menu-footer">
              <button type="button" onClick={() => setSidebarExpanded(false)} className="logout-button" style={{marginRight: '10px'}}>Close Menu</button>
              <button type="button" onClick={handleLogout} className="logout-button">Logout</button>
            </div>
          </aside>
          )}
        </main>
      </div>
    )
 }
export default App
