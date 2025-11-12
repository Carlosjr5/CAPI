

import React, { useEffect, useMemo, useRef } from 'react'

const DEFAULT_SYMBOL = 'BITGET:BTCUSDT.P'

function normalizeSymbol(rawSymbol) {
  if (!rawSymbol) return DEFAULT_SYMBOL
  if (rawSymbol.includes(':')) return rawSymbol
  const trimmed = String(rawSymbol).replace(/\s+/g, '').toUpperCase()
  // Assume Bitget perpetuals when no exchange prefix provided
  if (trimmed === 'BTC') {
    return 'BITGET:BTCUSDT.P'
  } else if (trimmed === 'ETH') {
    return 'BITGET:ETHUSDT.P'
  }
  return `BITGET:${trimmed}.P`
}

async function loadTradingViewScript() {
  if (typeof window === 'undefined') return
  if (window.TradingView && window.TradingView.widget) return
  if (window.__tvScriptLoadingPromise) {
    await window.__tvScriptLoadingPromise
    return
  }

  window.__tvScriptLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/tv.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = (err) => reject(err)
    document.head.appendChild(script)
  })

  try {
    await window.__tvScriptLoadingPromise
  } catch (error) {
    console.error('[TradingView] Failed to load tv.js', error)
  }
}

function plotTradeSignals(chart, trades) {
  if (!chart || !trades || !Array.isArray(trades)) return

  console.log('[TradingView] Plotting trade signals for', trades.length, 'trades')

  // Clear existing trade signals
  try {
    const shapes = chart.getAllShapes()
    const tradeShapes = shapes.filter(shape => shape.name?.includes('trade-signal'))
    console.log('[TradingView] Clearing', tradeShapes.length, 'existing trade signals')
    tradeShapes.forEach(shape => chart.removeEntity(shape.id))
  } catch (error) {
    console.warn('[TradingView] Error clearing trade signals', error)
  }

  // Plot each trade signal
  trades.forEach(trade => {
    if (!trade || !trade.signal || !trade.created_at || !trade.price) {
      console.log('[TradingView] Skipping trade - missing data:', trade?.id)
      return
    }

    const timestamp = trade.created_at * 1000 // Convert to milliseconds
    const price = parseFloat(trade.price)
    const signal = trade.signal.toUpperCase()

    if (isNaN(timestamp) || isNaN(price)) {
      console.log('[TradingView] Skipping trade - invalid timestamp/price:', trade?.id, timestamp, price)
      return
    }

    try {
      // Create a marker for each trade - adjust shape based on signal
      const marker = {
        time: timestamp / 1000, // TradingView expects seconds, not milliseconds
        position: signal === 'BUY' ? 'belowBar' : 'aboveBar',
        color: signal === 'BUY' ? '#4ade80' : '#f87171', // Green for BUY, Red for SELL
        shape: signal === 'BUY' ? 'arrowUp' : 'arrowDown', // Arrow up for BUY, down for SELL
        text: signal === 'BUY' ? 'LONG' : 'SHORT', // Show LONG/SHORT instead of BUY/SELL
        size: 1, // Smaller size as requested
        id: `trade-signal-${trade.id}`
      }

      console.log('[TradingView] Creating shape for trade', trade.id, 'at time', timestamp / 1000)
      chart.createShape(marker)
    } catch (error) {
      console.warn(`[TradingView] Error plotting trade signal for ${trade.id}`, error)
    }
  })
}

export default function TradingViewChart({
  latestOpenTrade,
  trades = [],
  symbol: symbolProp = DEFAULT_SYMBOL,
  height = '100%',
}) {
  const containerRef = useRef(null)
  const widgetRef = useRef(null)
  const saveTimerRef = useRef(null)
  const containerIdRef = useRef(`tv-chart-${Math.random().toString(36).slice(2)}`)
  const layoutKeyRef = useRef('')

  const resolvedHeightValue = height || '100%'
  const minHeight = useMemo(() => {
    if (typeof resolvedHeightValue !== 'string' || resolvedHeightValue.trim() === '') {
      return resolvedHeightValue || '720px'
    }
    const lowered = resolvedHeightValue.toLowerCase()
    if (lowered.includes('%') || lowered.includes('vh') || lowered.includes('auto')) {
      return '380px' // Match the new min-height from CSS
    }
    return resolvedHeightValue
  }, [resolvedHeightValue])

  const resolvedSymbol = useMemo(() => {
   // Prioritize the symbol prop (from button selection), then fall back to latest open trade symbol
   if (symbolProp) {
     return normalizeSymbol(symbolProp)
   }
   if (latestOpenTrade?.symbol) {
     return normalizeSymbol(latestOpenTrade.symbol)
   }
   return DEFAULT_SYMBOL
 }, [symbolProp, latestOpenTrade])

 // Filter trades for current symbol
 const symbolTrades = useMemo(() => {
   return trades.filter(trade => normalizeSymbol(trade.symbol) === resolvedSymbol)
 }, [trades, resolvedSymbol])

  useEffect(() => {
    let mounted = true

    const teardownWidget = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      if (widgetRef.current && widgetRef.current.remove) {
        widgetRef.current.remove()
      }
      widgetRef.current = null
    }

    const persistLayout = () => {
      if (!widgetRef.current || !widgetRef.current.save) return
      if (!layoutKeyRef.current) return
      widgetRef.current.save((state) => {
        if (!state) return
        try {
          localStorage.setItem(layoutKeyRef.current, JSON.stringify(state))
        } catch (error) {
          console.warn('[TradingView] Failed to persist chart layout', error)
        }
      })
    }

    const enqueuePersist = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }
      saveTimerRef.current = window.setTimeout(persistLayout, 800)
    }

    const handleBeforeUnload = () => {
      persistLayout()
    }

    const createWidget = async () => {
      await loadTradingViewScript()
      if (!mounted) return
      if (!containerRef.current || !window.TradingView?.widget) return

      teardownWidget()

      layoutKeyRef.current = `tv-chart-layout-${resolvedSymbol.replace(/[^A-Za-z0-9:_-]/g, '-')}`

      let savedData
      try {
        const raw = localStorage.getItem(layoutKeyRef.current)
        if (raw) {
          savedData = JSON.parse(raw)
        }
      } catch (error) {
        console.warn('[TradingView] Failed to parse saved chart layout', error)
      }

      widgetRef.current = new window.TradingView.widget({
        autosize: true,
        symbol: resolvedSymbol,
        interval: '60',
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        locale: 'en',
        toolbar_bg: '#0f172a',
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_side_toolbar: false,
        allow_symbol_change: false,
        drawings_access: { type: 'all' },
        save_image: true,
        withdateranges: true,
        container_id: containerIdRef.current,
        support_host: 'https://www.tradingview.com',
        disabled_features: [],
        enabled_features: [
          'use_localstorage_for_settings',
          'save_chart_properties_to_local_storage',
          'side_toolbar_in_fullscreen_mode',
        ],
        saved_data: savedData,
      })

      if (typeof widgetRef.current?.onChartReady === 'function') {
        widgetRef.current.onChartReady(() => {
         enqueuePersist()

         const chart = widgetRef.current?.activeChart?.()
         if (chart) {
           try {
             chart.onIntervalChanged().subscribe(null, enqueuePersist)
             chart.onSymbolChanged().subscribe(null, enqueuePersist)
             chart.onDataLoaded().subscribe(enqueuePersist)
           } catch (error) {
             console.warn('[TradingView] Failed to wire chart events', error)
           }

           // Plot trade signals on chart initially
           plotTradeSignals(chart, symbolTrades)
         }

         try {
           widgetRef.current?.subscribe('drawing_tool', enqueuePersist)
         } catch (error) {
           // Safe to ignore if subscribe is unavailable
         }
       }).catch(error => {
         console.error('[TradingView] onChartReady failed', error)
       })
      } else {
        console.warn('[TradingView] onChartReady not available, skipping chart setup')
      }

      // Also plot signals after widget is created (for when trades update)
      setTimeout(() => {
        if (widgetRef.current?.activeChart) {
          const chart = widgetRef.current.activeChart()
          if (chart) {
            plotTradeSignals(chart, symbolTrades)
         }
       }
     }, 1000)

     // Additional fallback: plot signals after a longer delay for slower loading
     setTimeout(() => {
       if (widgetRef.current?.activeChart) {
         const chart = widgetRef.current.activeChart()
         if (chart) {
           plotTradeSignals(chart, symbolTrades)
         }
       }
     }, 3000)

      window.addEventListener('beforeunload', handleBeforeUnload)
    }

    createWidget()

    return () => {
      mounted = false
      window.removeEventListener('beforeunload', handleBeforeUnload)
      teardownWidget()
    }
  }, [resolvedSymbol, symbolTrades])

  // Re-plot signals when trades update
  useEffect(() => {
    if (widgetRef.current?.activeChart && symbolTrades.length > 0) {
      const chart = widgetRef.current.activeChart()
      if (chart) {
        plotTradeSignals(chart, symbolTrades)
      }
    }
  }, [symbolTrades])

  return (
    <div className="tradingview-widget-wrapper" style={{ height: resolvedHeightValue, width: '100%', position: 'relative', overflow: 'hidden', minHeight }}>
      <div className="tradingview-widget-container" style={{ height: '100%', width: '100%', position: 'relative', minHeight }}>
        <div
          id={containerIdRef.current}
          className="tradingview-widget-container__widget"
          ref={containerRef}
          style={{ height: '100%', width: '100%', minHeight }}
        />
      </div>
    </div>
  )
}

