import React, { useEffect, useRef } from 'react'

export default function TradingViewChart({ symbol = 'BITGET:BTCUSDT.P', height = '100%', positionSignals = [] }) {
  const containerRef = useRef(null)
  const scriptLoadedRef = useRef(false)

  useEffect(() => {
    if (!containerRef.current) return

    // Only create script once
    if (!scriptLoadedRef.current) {
      // Prepare initial signals data for TradingView
      const signals = positionSignals.map(trade => ({
        time: trade.created_at,
        position: trade.signal?.toUpperCase() === 'BUY' ? 'long' : 'short',
        short_name: trade.signal?.toUpperCase() === 'BUY' ? 'L' : 'S',
        long_name: trade.signal?.toUpperCase() === 'BUY' ? 'Long Position' : 'Short Position',
        color: trade.signal?.toUpperCase() === 'BUY' ? '#22c55e' : '#ef4444'
      }))

      const script = document.createElement('script')
      script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
      script.type = 'text/javascript'
      script.async = true
      script.innerHTML = JSON.stringify({
        autosize: true,
        symbol,
        interval: '60',
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        locale: 'en',
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_legend: false,
        allow_symbol_change: false,
        calendar: false,
        support_host: 'https://www.tradingview.com',
        height: 500,
        signals: signals.length > 0 ? signals : undefined
      })

      containerRef.current.innerHTML = ''
      containerRef.current.appendChild(script)
      scriptLoadedRef.current = true
    }

    // Don't recreate script on prop changes - just update the container if needed
  }, []) // Empty dependency array - only run once

  // Handle position signals updates separately without recreating the chart
  useEffect(() => {
    // If we need to update signals, we could potentially call TradingView's update methods
    // But for now, we'll avoid constant re-rendering
  }, [positionSignals])

  return (
    <div className="tradingview-widget-wrapper" style={{ height: height, width: '100%', position: 'relative', overflow: 'hidden', minHeight: '500px' }}>
      <div className="tradingview-widget-container" style={{ height: '100%', width: '100%', position: 'relative', minHeight: '500px' }}>
        <div className="tradingview-widget-container__widget" ref={containerRef} style={{ height: '100%', width: '100%', minHeight: '500px' }} />
      </div>
    </div>
  )
}

