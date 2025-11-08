import React, { useEffect, useMemo, useRef } from 'react'

const DEFAULT_SYMBOL = 'BITGET:BTCUSDT.P'

function normalizeSymbol(rawSymbol) {
  if (!rawSymbol) return DEFAULT_SYMBOL
  if (rawSymbol.includes(':')) return rawSymbol
  const trimmed = String(rawSymbol).replace(/\s+/g, '').toUpperCase()
  // Assume Bitget perpetuals when no exchange prefix provided
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

export default function TradingViewChart({
  latestOpenTrade,
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
      return '720px'
    }
    return resolvedHeightValue
  }, [resolvedHeightValue])

  const resolvedSymbol = useMemo(() => {
    if (latestOpenTrade?.symbol) {
      return normalizeSymbol(latestOpenTrade.symbol)
    }
    if (symbolProp) {
      return normalizeSymbol(symbolProp)
    }
    return DEFAULT_SYMBOL
  }, [latestOpenTrade, symbolProp])

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
        }

        try {
          widgetRef.current?.subscribe('drawing_tool', enqueuePersist)
        } catch (error) {
          // Safe to ignore if subscribe is unavailable
        }
      })

      window.addEventListener('beforeunload', handleBeforeUnload)
    }

    createWidget()

    return () => {
      mounted = false
      window.removeEventListener('beforeunload', handleBeforeUnload)
      teardownWidget()
    }
  }, [resolvedSymbol])

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

