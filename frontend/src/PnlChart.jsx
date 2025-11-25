import React, { useState, useEffect, useMemo, useRef } from 'react';

const PnlChart = ({ trades = [], currentPrices = {}, bitgetPositions = {}, totalPnL }) => {
  const [selectedInterval, setSelectedInterval] = useState('1MIN');
  const [tick, setTick] = useState(0);
  const [chartHeight, setChartHeight] = useState(250);
  const [chartWidth, setChartWidth] = useState(400);
  const [zoomLevel, setZoomLevel] = useState(1); // 1 = default, >1 = zoomed in, <1 = zoomed out
  const [isMobile, setIsMobile] = useState(false);
  // Tooltip state: index of the active dot, or null
  const [activeTooltipIndex, setActiveTooltipIndex] = useState(null);
  const chartRef = useRef();

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
     const updateDimensions = () => {
       if (chartRef.current) {
         const height = chartRef.current.clientHeight;
         const width = chartRef.current.clientWidth;
         setIsMobile(window.innerWidth < 768);
         const marginX = isMobile ? 85 : 105; // Y-axis label width + padding
         const marginY = isMobile ? 40 : 50;
         if (height > 0) setChartHeight(height - marginY);
         if (width > 0) setChartWidth((width - marginX) * zoomLevel);
       }
     };
     updateDimensions();
     window.addEventListener('resize', updateDimensions);
     return () => window.removeEventListener('resize', updateDimensions);
   }, [isMobile]);

  const intervals = [
    { key: '1MIN', label: '1M' },
    { key: '15MIN', label: '15M' },
    { key: '30MIN', label: '30M' },
    { key: '1H', label: '1H' },
    { key: '1D', label: '1D' },
    { key: '1W', label: '1W' },
    { key: '1M', label: '1M' }
  ];

  const mapStatus = (status) => {
    if (!status) return 'other';
    const statusValue = status.toLowerCase();
    if (statusValue === 'placed') return 'open';
    if (
      statusValue.includes('filled') ||
      statusValue.includes('closed') ||
      statusValue.includes('rejected') ||
      statusValue.includes('error') ||
      statusValue.includes('ignored') ||
      statusValue === 'signal'
    )
      return 'closed';
    return 'other';
  };

  // Helper function to get the direction multiplier for a trade
  const getTradeMultiplier = (signal) => {
    if (!signal) return 1; // Default to positive for unknown signals
    const upperSignal = signal.toUpperCase();
    // Positive multiplier for BUY/LONG positions (profit when price goes up)
    if (upperSignal === 'BUY' || upperSignal === 'LONG') {
      return 1;
    }
    // Negative multiplier for SELL/SHORT positions (profit when price goes down)
    if (upperSignal === 'SELL' || upperSignal === 'SHORT') {
      return -1;
    }
    return 1; // Default to positive for unknown signals
  };

  // Helper function to calculate P&L for a trade
  const calculateTradePnL = (trade) => {
    const statusKey = mapStatus(trade.status);
    const multiplier = getTradeMultiplier(trade.signal);

    if (statusKey === 'closed') {
      // For closed trades, use stored realized_pnl
      const realized = Number(trade.realized_pnl ?? trade.realizedPnl);
      if (Number.isFinite(realized)) {
        return realized;
      }
      // Fallback calculation if realized_pnl is not available
      const exitPrice = Number(trade.exit_price ?? trade.exitPrice);
      const entryPrice = Number(trade.price);
      let sizeValue = Number(trade.size);
      // Use absolute size magnitude. Direction is applied via multiplier based on signal.
      if (Number.isFinite(sizeValue)) {
        sizeValue = Math.abs(sizeValue);
      }

      if (!Number.isFinite(sizeValue)) {
        const sizeUsd = Number(trade.size_usd ?? trade.sizeUsd);
        if (Number.isFinite(sizeUsd) && Number.isFinite(entryPrice) && entryPrice !== 0) {
          sizeValue = sizeUsd / entryPrice;
        }
      }

      if (Number.isFinite(exitPrice) && Number.isFinite(entryPrice) && Number.isFinite(sizeValue)) {
        const r = (exitPrice - entryPrice) * sizeValue * multiplier;
        return Number.isFinite(r) ? r : 0;
      }
    } else {
      // For open trades, calculate based on current market price
      const entryPrice = Number(trade.price);
      let sizeValue = Number(trade.size);
      // Use absolute size magnitude. Direction is applied via multiplier based on signal.
      if (Number.isFinite(sizeValue)) {
        sizeValue = Math.abs(sizeValue);
      }
      const currentPrice = Number(currentPrices[trade.symbol]);

      if (!Number.isFinite(sizeValue)) {
        const sizeUsd = Number(trade.size_usd ?? trade.sizeUsd);
        if (Number.isFinite(sizeUsd) && Number.isFinite(entryPrice) && entryPrice !== 0) {
          sizeValue = sizeUsd / entryPrice;
        }
      }

      if (Number.isFinite(currentPrice) && Number.isFinite(entryPrice) && Number.isFinite(sizeValue)) {
        const r = (currentPrice - entryPrice) * sizeValue * multiplier;
        return Number.isFinite(r) ? r : 0;
      }

      // Fallback to stored unrealized_pnl if available
      const fallback = Number(trade.unrealized_pnl || 0);
      return Number.isFinite(fallback) ? fallback : 0;
    }
  };

  // Calculate cumulative P&L over time with time-based aggregation
  const staticChartData = useMemo(() => {
    if (trades.length === 0) return [];
    const sortedTrades = [...trades].sort((tradeA, tradeB) => tradeA.created_at - tradeB.created_at);
    let intervalMs = 60000; // default 1 minute
    if (selectedInterval === '15MIN') intervalMs = 15 * 60000;
    if (selectedInterval === '30MIN') intervalMs = 30 * 60000;
    if (selectedInterval === '1H') intervalMs = 60 * 60000;
    if (selectedInterval === '1D') intervalMs = 24 * 60 * 60000;
    if (selectedInterval === '1W') intervalMs = 7 * 24 * 60 * 60000;
    if (selectedInterval === '1M') intervalMs = 30 * 24 * 60 * 60000;

    // Find the start and end time for the chart
    const startTime = sortedTrades.length > 0 ? sortedTrades[0].created_at * 1000 : Date.now();
    const endTime = Date.now();
    const data = [];
    for (let t = startTime; t <= endTime; t += intervalMs) {
      // Find all trades up to this time
      const tradesUpToT = sortedTrades.filter(trade => trade.created_at * 1000 <= t);
      let totalPnl = 0;
        for (const trade of tradesUpToT) {
          const tradePnl = calculateTradePnL(trade);
          if (Number.isFinite(Number(tradePnl))) {
            totalPnl += tradePnl;
          }
        }
      data.push({
        time: new Date(t),
        pnl: totalPnl,
        change: 0,
        index: data.length,
        tradeCount: tradesUpToT.length,
        hasTrades: tradesUpToT.length > 0
      });
    }
    return data;
  }, [trades, selectedInterval, currentPrices, totalPnL]);

  // Helper function to calculate total P&L at a specific time
  const getTotalPnLAtTime = (timestampMs) => {
    const sortedTrades = [...trades].sort((tradeA, tradeB) => tradeA.created_at - tradeB.created_at);
    let totalPnl = 0;

    for (const trade of sortedTrades) {
      const tradeTime = trade.created_at * 1000; // Convert to milliseconds
      if (tradeTime <= timestampMs) {
        // For closed trades, use realized P&L
        if (mapStatus(trade.status) === 'closed') {
          const realized = Number(trade.realized_pnl ?? trade.realizedPnl);
          if (Number.isFinite(realized)) {
            totalPnl += realized;
          } else {
            // Fallback calculation
            totalPnl += calculateTradePnL(trade);
          }
        } else {
          // For open trades, calculate current P&L at this timestamp
          const entryPrice = Number(trade.price);
          let sizeValue = Number(trade.size);
          if (Number.isFinite(sizeValue)) {
            sizeValue = Math.abs(sizeValue);
          }
          const multiplier = getTradeMultiplier(trade.signal);

          if (!Number.isFinite(sizeValue)) {
            const sizeUsd = Number(trade.size_usd ?? trade.sizeUsd);
            if (Number.isFinite(sizeUsd) && Number.isFinite(entryPrice) && entryPrice !== 0) {
              sizeValue = sizeUsd / entryPrice;
            }
          }

          // Use historical price if available, otherwise current price
          const priceToUse = currentPrices[trade.symbol] || entryPrice;
          if (Number.isFinite(Number(priceToUse)) && Number.isFinite(Number(entryPrice)) && Number.isFinite(Number(sizeValue))) {
            totalPnl += (Number(priceToUse) - Number(entryPrice)) * Number(sizeValue) * multiplier;
          }
        }
      }
    }

    return totalPnl;
  };

  const chartData = staticChartData;

  const EM_DASH = '\u2014'
  const formatCurrency = (value) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return EM_DASH
    const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(num));
    // Only show '-' for negative values, never for positive
    return num < 0 ? `-${formatted}` : formatted;
  };

  const formatTimeAgo = (minutes) => {
    if (minutes < 60) return `${Math.round(minutes)}m ago`;
    if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
    return `${Math.round(minutes / 1440)}d ago`;
  };

  const formatTimeLabel = (date, interval) => {
    if (interval === 'live') {
      return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    switch (interval) {
      case '1MIN':
      case '15MIN':
      case '30MIN':
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      case '1H':
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      case '1D':
        return date.toLocaleDateString();
      case '1W':
        return `Week of ${date.toLocaleDateString()}`;
      case '1M':
        return date.toLocaleDateString([], { year: 'numeric', month: 'short' });
      default:
        return date.toLocaleDateString();
    }
  };

  const formatDateTime = (date) => {
    try {
      return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return String(date);
    }
  };

  // Cleaned up rendering logic for graph and axis
  if (chartData.length === 0 && trades.length > 0) {
    // Use the same logic as the main chart for total P&L
    const latestPnl = trades.length > 0 ? trades
      .map(t => calculateTradePnL(t))
      .filter(p => Number.isFinite(Number(p)))
      .reduce((sum, pnl) => sum + pnl, 0) : 0;
    const trueTotalPnL = typeof totalPnL === 'number' ? totalPnL : latestPnl;
    return (
      <div ref={chartRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: isMobile ? '4px' : '8px', marginBottom: isMobile ? '8px' : '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
          {intervals.map((interval) => (
            <button
              key={interval.key}
              onClick={() => setSelectedInterval(interval.key)}
              style={{
                padding: isMobile ? '4px 8px' : '6px 12px',
                border: '1px solid rgba(148, 163, 184, 0.3)',
                borderRadius: '6px',
                background: selectedInterval === interval.key ? 'rgba(96, 165, 250, 0.2)' : 'rgba(15, 23, 42, 0.5)',
                color: selectedInterval === interval.key ? '#60a5fa' : 'rgba(148, 163, 184, 0.8)',
                fontSize: isMobile ? '11px' : '12px',
                fontWeight: selectedInterval === interval.key ? '600' : '400',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                boxShadow: selectedInterval === interval.key ? '0 0 10px rgba(96, 165, 250, 0.3)' : 'none'
              }}
            >
              {interval.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'row', width: '100%', height: 'calc(100% - 50px)', borderRadius: '8px', background: 'linear-gradient(180deg, rgba(15, 23, 42, 0.3) 0%, rgba(15, 23, 42, 0.1) 100%)', boxShadow: 'inset 0 0 20px rgba(0, 0, 0, 0.1)' }}>
          <div style={{ position: 'relative', flex: 1, height: '100%', borderBottom: '2px solid rgba(148, 163, 184, 0.4)', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', right: '0', top: '0', height: '100%', width: isMobile ? '75px' : '95px', minWidth: isMobile ? '75px' : '95px', borderLeft: '2px solid rgba(148, 163, 184, 0.4)', background: 'rgba(15, 23, 42, 0.08)', zIndex: 10, pointerEvents: 'none', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: isMobile ? '8px 0' : '20px 0' }}>
              <div style={{ fontWeight: '700', color: '#fff', background: 'rgba(15, 23, 42, 0.95)', borderRadius: '8px', padding: '8px 12px', fontSize: isMobile ? '12px' : '14px', border: '2px solid rgba(148, 163, 184, 0.4)', fontFamily: 'monospace', boxShadow: '0 4px 20px rgba(0,0,0,0.5)', textAlign: 'center' }}>
                {formatCurrency(trueTotalPnL)}
              </div>
            </div>
            <svg width="100%" height="100%" viewBox={`0 0 ${chartWidth} ${chartHeight}`} style={{ overflow: 'visible' }}>
              <circle
                cx={chartWidth / 2}
                cy={chartHeight / 2}
                r="6"
                fill={trueTotalPnL >= 0 ? '#10b981' : '#ef4444'}
                stroke="#fff"
                strokeWidth="2"
              />
            </svg>
          </div>
        </div>
      </div>
    );
  }
  if (chartData.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '350px', color: 'rgba(148, 163, 184, 0.7)', fontSize: '14px' }}>
        <div style={{ display: 'flex', gap: isMobile ? '4px' : '8px', marginBottom: '20px', flexWrap: 'wrap', justifyContent: 'center' }}>
          {intervals.map((interval) => (
            <button
              key={interval.key}
              onClick={() => setSelectedInterval(interval.key)}
              style={{
                padding: isMobile ? '4px 8px' : '6px 12px',
                border: '1px solid rgba(148, 163, 184, 0.3)',
                borderRadius: '6px',
                background: selectedInterval === interval.key ? 'rgba(96, 165, 250, 0.2)' : 'rgba(15, 23, 42, 0.5)',
                color: selectedInterval === interval.key ? '#60a5fa' : 'rgba(148, 163, 184, 0.8)',
                fontSize: isMobile ? '11px' : '12px',
                fontWeight: selectedInterval === interval.key ? '600' : '400',
                cursor: 'pointer',
                transition: 'all 0.2s ease'
              }}
            >
              {interval.label}
            </button>
          ))}
        </div>
        No trade data available for P&L chart
      </div>
    );
  }

  // Calculate time range for proper X-axis scaling
  const timeStamps = chartData.map(d => d.time.getTime());
  let minTime = Math.min(...timeStamps);
  let maxTime = Math.max(...timeStamps);
  let timeRange = maxTime - minTime;
  // Adjust timeRange for zoom
  if (zoomLevel !== 1 && timeRange > 0) {
    const center = minTime + timeRange / 2;
    const newRange = timeRange / zoomLevel;
    minTime = center - newRange / 2;
    maxTime = center + newRange / 2;
    timeRange = maxTime - minTime;
  }
  // Ensure timeRange is never zero or negative
  timeRange = Math.max(timeRange, 1);
  // Ensure minTime and maxTime are valid
  if (isNaN(minTime) || isNaN(maxTime)) {
    minTime = Date.now() - 5 * 60 * 1000;
    maxTime = Date.now();
    timeRange = maxTime - minTime;
  }

  // For live mode, force the time range to be the full 5-minute window plus buffer to expand the line across the X-axis
  let minPnl, maxPnl, range;
  // Use the passed totalPnL prop for the true Total P&L (realized + unrealized)
  const latestPnl = chartData.length > 0 ? chartData[chartData.length - 1].pnl : 0;
  const trueTotalPnL = typeof totalPnL === 'number' ? totalPnL : latestPnl;

  // Calculate Y-axis range to center on current total P&L with proportional movement
  const allPnls = chartData.map(d => d.pnl).filter(v => !isNaN(v) && isFinite(v));
  let dataMin = trueTotalPnL;
  let dataMax = trueTotalPnL;
  if (allPnls.length > 0) {
    dataMin = Math.min(...allPnls, trueTotalPnL);
    dataMax = Math.max(...allPnls, trueTotalPnL);
  }
  // Fallback if min/max are NaN or equal
  if (!isFinite(dataMin) || !isFinite(dataMax) || dataMin === dataMax) {
    dataMin = trueTotalPnL - 10;
    dataMax = trueTotalPnL + 10;
  }
  const deviationAbove = Math.max(0, dataMax - trueTotalPnL);
  const deviationBelow = Math.max(0, trueTotalPnL - dataMin);
  const maxDeviation = Math.max(deviationAbove, deviationBelow, 10);
  minPnl = trueTotalPnL - maxDeviation;
  maxPnl = trueTotalPnL + maxDeviation;
  range = Math.max(maxPnl - minPnl, 0.01);

  if (selectedInterval === 'live') {
    const now = Date.now();
    const fiveMinutesMs = 5 * 60 * 1000;
    const bufferMs = 30 * 1000; // 30 seconds buffer for future
    minTime = now - fiveMinutesMs;
    maxTime = now + bufferMs;
    timeRange = maxTime - minTime;
  } else {
    // For other modes, set maxTime to the last data point for proper time scaling
    maxTime = chartData.length > 0 ? chartData[chartData.length - 1].time.getTime() : Date.now();
    timeRange = maxTime - minTime || 1;
  }

  return (
    <div ref={chartRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {/* Interval selector and zoom controls */}
      <div style={{
        display: 'flex',
        gap: isMobile ? '4px' : '8px',
        marginBottom: isMobile ? '8px' : '10px',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center'
      }}>
        {intervals.map((interval) => (
          <button
            key={interval.key}
            onClick={() => setSelectedInterval(interval.key)}
            style={{
              padding: isMobile ? '4px 8px' : '6px 12px',
              border: '1px solid rgba(148, 163, 184, 0.3)',
              borderRadius: '6px',
              background: selectedInterval === interval.key ? 'rgba(96, 165, 250, 0.2)' : 'rgba(15, 23, 42, 0.5)',
              color: selectedInterval === interval.key ? '#60a5fa' : 'rgba(148, 163, 184, 0.8)',
              fontSize: isMobile ? '11px' : '12px',
              fontWeight: selectedInterval === interval.key ? '600' : '400',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              boxShadow: selectedInterval === interval.key ? '0 0 10px rgba(96, 165, 250, 0.3)' : 'none'
            }}
          >
            {interval.label}
          </button>
        ))}
        {/* Zoom controls */}
        <button
          onClick={() => setZoomLevel(z => Math.min(z + 0.5, 5))}
          style={{
            marginLeft: '12px',
            padding: isMobile ? '4px 8px' : '6px 12px',
            border: '1px solid #60a5fa',
            borderRadius: '6px',
            background: 'rgba(96, 165, 250, 0.15)',
            color: '#60a5fa',
            fontSize: isMobile ? '13px' : '15px',
            fontWeight: '600',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            boxShadow: '0 0 6px rgba(96, 165, 250, 0.1)'
          }}
          title="Zoom In"
        >
          +
        </button>
        <button
          onClick={() => setZoomLevel(z => Math.max(z - 0.5, 0.5))}
          style={{
            marginLeft: '4px',
            padding: isMobile ? '4px 8px' : '6px 12px',
            border: '1px solid #60a5fa',
            borderRadius: '6px',
            background: 'rgba(96, 165, 250, 0.10)',
            color: '#60a5fa',
            fontSize: isMobile ? '13px' : '15px',
            fontWeight: '600',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            boxShadow: '0 0 6px rgba(96, 165, 250, 0.1)'
          }}
          title="Zoom Out"
        >
          -
        </button>
        <button
          onClick={() => setZoomLevel(1)}
          style={{
            marginLeft: '4px',
            padding: isMobile ? '4px 8px' : '6px 12px',
            border: '1px solid #60a5fa',
            borderRadius: '6px',
            background: 'rgba(96, 165, 250, 0.08)',
            color: '#60a5fa',
            fontSize: isMobile ? '13px' : '15px',
            fontWeight: '600',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            boxShadow: '0 0 6px rgba(96, 165, 250, 0.1)'
          }}
          title="Reset Zoom"
        >
          Reset
        </button>
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100%',
        height: 'calc(100% - 50px)',
        borderRadius: '8px',
        background: 'linear-gradient(180deg, rgba(15, 23, 42, 0.3) 0%, rgba(15, 23, 42, 0.1) 100%)',
        boxShadow: 'inset 0 0 20px rgba(0, 0, 0, 0.1)'
      }}>

        {/* Chart area */}
        <div style={{
          position: 'relative',
          flex: 1,
          height: '100%',
          borderBottom: '2px solid rgba(148, 163, 184, 0.4)',
          overflow: 'hidden'
        }}>
        {/* Y-axis labels on the right side - perfectly centered */}
        <div style={{
          position: 'absolute',
          right: '0',
          top: '0',
          height: '100%',
          width: '0',
          minWidth: isMobile ? '75px' : '95px',
          borderLeft: '2px solid rgba(148, 163, 184, 0.4)',
          background: 'rgba(15, 23, 42, 0.08)',
          zIndex: 10,
          pointerEvents: 'none'
        }}>
            {/* Y-axis: max, current, min */}
            <div style={{
              position: 'absolute',
              top: '5px',
              left: '50%',
              transform: 'translateX(-50%)',
              fontWeight: '500',
              color: 'rgba(148, 163, 184, 0.9)',
              fontSize: isMobile ? '9px' : '10px',
              fontFamily: 'monospace',
              background: 'rgba(15, 23, 42, 0.6)',
              borderRadius: '4px',
              padding: '2px 6px',
              border: '1px solid rgba(148, 163, 184, 0.2)'
            }}>
              {maxPnl >= 0 ? formatCurrency(maxPnl) : formatCurrency(maxPnl)}
            </div>

            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              fontWeight: '700',
              color: '#fff',
              background: 'rgba(15, 23, 42, 0.95)',
              borderRadius: '8px',
              padding: '8px 12px',
              fontSize: isMobile ? '12px' : '14px',
              border: '2px solid rgba(148, 163, 184, 0.4)',
              fontFamily: 'monospace',
              boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
              textAlign: 'center'
            }}>
              {trueTotalPnL >= 0 ? formatCurrency(trueTotalPnL) : formatCurrency(trueTotalPnL)}
            </div>

            <div style={{
              position: 'absolute',
              bottom: '5px',
              left: '50%',
              transform: 'translateX(-50%)',
              fontWeight: '500',
              color: 'rgba(148, 163, 184, 0.9)',
              fontSize: isMobile ? '9px' : '10px',
              fontFamily: 'monospace',
              background: 'rgba(15, 23, 42, 0.6)',
              borderRadius: '4px',
              padding: '2px 6px',
              border: '1px solid rgba(148, 163, 184, 0.2)'
            }}>
              {minPnl >= 0 ? formatCurrency(minPnl) : formatCurrency(minPnl)}
            </div>

            {/* Removed Updated timestamp from chart */}
          </div>
          <svg width="100%" height="100%" viewBox={`0 0 ${chartWidth + (isMobile ? 75 : 95)} ${chartHeight}`} style={{ overflow: 'visible' }}>
            <defs>
              <linearGradient id="positiveGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#10b981" stopOpacity="0.4" />
                <stop offset="50%" stopColor="#10b981" stopOpacity="0.2" />
                <stop offset="100%" stopColor="#10b981" stopOpacity="0.05" />
              </linearGradient>
              <linearGradient id="negativeGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#ef4444" stopOpacity="0.4" />
                <stop offset="50%" stopColor="#ef4444" stopOpacity="0.2" />
                <stop offset="100%" stopColor="#ef4444" stopOpacity="0.05" />
              </linearGradient>
            </defs>
            {/* Only keep grid lines, no extra axis or border */}
            {Array.from({ length: 5 }).map((_, i) => {
              const y = (chartHeight / 4) * i;
              return (
                <line key={`ygrid-${i}`} x1={0} y1={y} x2={chartWidth} y2={y} stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="3,3" />
              );
            })}
            {Array.from({ length: 9 }).map((_, i) => {
              // 9 intervals, closer together
              if (i === 4) return null; // skip center for clarity
              const x = (chartWidth / 8) * i;
              const timeAtFraction = minTime + (timeRange * i / 8);
              return (
                <g key={`xgrid-${i}`}>
                  <line x1={x} y1={0} x2={x} y2={chartHeight} stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="3,3" />
                  <text x={x} y={chartHeight + 18} fontSize={isMobile ? 10 : 12} fill="#94a3b8" fontFamily="monospace" textAnchor="middle">
                    {formatTimeLabel(new Date(timeAtFraction), selectedInterval)}
                  </text>
                </g>
              );
            })}
          {/* Add more vertical grid lines for compactness */}
          {Array.from({ length: 9 }).map((_, i) => {
            if (i === 0) return null;
            const x = (chartWidth / 8) * i;
            return (
              <line key={`vgrid-${i}`} x1={x} y1="0" x2={x} y2={chartHeight} stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="3,3" />
            );
          })}
          <line x1={chartWidth + (isMobile ? 75 : 95)} y1="0" x2={chartWidth + (isMobile ? 75 : 95)} y2={chartHeight} stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="3,3" />

          {/* Area fill based on P&L sign */}
          {/* Horizontal line for current P&L value */}
          {chartData.length > 0 && (
            <>
              {/* Removed blue horizontal line after the dot */}
              {/* No dot or text label needed since we have it properly displayed in Y-axis */}
            </>
          )}
          {(() => {
            const polygonPoints = chartData.map((point) => {
              const x = ((point.time.getTime() - minTime) / Math.max(timeRange, 1)) * chartWidth;
              const y = chartHeight - ((point.pnl - minPnl) / Math.max(range, 0.01)) * chartHeight;
              if (isNaN(x) || isNaN(y)) return null;
              return `${x},${y}`;
            }).filter(Boolean).join(' ');
            const endX = chartWidth;
            return (
              <polygon
                fill={chartData.length > 0 && chartData[chartData.length - 1].pnl >= 0 ? "url(#positiveGradient)" : "url(#negativeGradient)"}
                stroke="none"
                points={`0,${chartHeight} ${polygonPoints} ${endX},${chartHeight}`}
              />
            );
          })()}

          {/* P&L line segments with color based on current total P&L */}
          {chartData.map((point, index) => {
            if (index === 0) return null;
            const prevPoint = chartData[index - 1];
            const x1 = ((prevPoint.time.getTime() - minTime) / Math.max(timeRange, 1)) * chartWidth;
            const y1 = chartHeight - ((prevPoint.pnl - minPnl) / Math.max(range, 0.01)) * chartHeight;
            const x2 = ((point.time.getTime() - minTime) / Math.max(timeRange, 1)) * chartWidth;
            const y2 = chartHeight - ((point.pnl - minPnl) / Math.max(range, 0.01)) * chartHeight;
            const isPositive = trueTotalPnL >= 0;
            if (isNaN(x1) || isNaN(x2)) return null;
            return (
              <g key={`line-${index}`}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={isPositive ? '#10b981' : '#ef4444'}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.5))' }}
                />
                {/* Only render a dot for the previous point if you specifically need it. We only show dots
                    when the P&L changes between consecutive points. The dot is rendered on the current point (x2)
                    below; removing the prev dot avoids duplicate markers. */}
                {/** Render dot + tooltip only when P&L changed from prevPoint to point **/}
                {prevPoint && Number(prevPoint.pnl) !== Number(point.pnl) && (
                  <>
                    <circle
                      cx={x2}
                      cy={y2}
                      r={index === chartData.length - 1 ? "5" : "3"}
                      fill={isPositive ? '#10b981' : '#ef4444'}
                      stroke="#fff"
                      strokeWidth={index === chartData.length - 1 ? "2" : "1"}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setActiveTooltipIndex(`dot-${index}`)}
                      onMouseLeave={() => setActiveTooltipIndex(null)}
                    />
                    {activeTooltipIndex === `dot-${index}` && (
                      <foreignObject x={x2 - 60} y={y2 - 56} width="120" height="44">
                        <div style={{
                          background: 'rgba(15,23,42,0.95)',
                          color: '#fff',
                          borderRadius: '6px',
                          padding: '6px 8px',
                          fontSize: '11px',
                          textAlign: 'center',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                          alignItems: 'center'
                        }}>
                          <div style={{ color: '#cbd5e1', fontSize: '11px', fontWeight: 600 }}>{formatDateTime(point.time)}</div>
                          <div style={{ color: point.pnl >= 0 ? '#4ade80' : '#f87171', fontWeight: 700 }}>{formatCurrency(point.pnl)}</div>
                        </div>
                      </foreignObject>
                    )}
                  </>
                )}
              </g>
            );
          })}

          {/* Remove duplicate dot, keep only the one at the end of the horizontal line */}

          <style>{`
            @keyframes pulse {
              0% { r: 6; }
              50% { r: 8; }
              100% { r: 6; }
            }
          `}</style>

          {/* Invisible hover areas for tooltips */}
          {chartData.map((point, index) => {
            if (index === 0) return null;
            const prevPoint = chartData[index - 1];
            const x1 = ((prevPoint.time.getTime() - minTime) / Math.max(timeRange, 1)) * chartWidth;
            const y1 = Math.max(0, Math.min(chartHeight, chartHeight - ((prevPoint.pnl - minPnl) / Math.max(range, 0.01)) * chartHeight));
            const x2 = ((point.time.getTime() - minTime) / Math.max(timeRange, 1)) * chartWidth;
            const y2 = Math.max(0, Math.min(chartHeight, chartHeight - ((point.pnl - minPnl) / Math.max(range, 0.01)) * chartHeight));

            // Invert Y coordinates for hover positioning
            const invertedY1 = chartHeight - y1;
            const invertedY2 = chartHeight - y2;

            // Skip invalid coordinates
            if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
              return null;
            }

            // Create hover area for this line segment (using inverted Y coordinates)
            const midX = (x1 + x2) / 2;
            const midY = (Math.min(invertedY1, invertedY2) + Math.max(invertedY1, invertedY2)) / 2;

            return (
              <rect
                key={`hover-${index}`}
                x={midX - 2}
                y={Math.min(invertedY1, invertedY2) - 8}
                width="4"
                height={Math.abs(invertedY2 - invertedY1) + 16}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  const tooltip = e.target.parentElement.querySelector(`#tooltip-${index}`);
                  if (tooltip) tooltip.style.display = 'block';
                }}
                onMouseLeave={(e) => {
                  const tooltip = e.target.parentElement.querySelector(`#tooltip-${index}`);
                  if (tooltip) tooltip.style.display = 'none';
                }}
              />
            );
          })}
        </svg>
        </div>

      {/* Removed X-axis labels at the bottom for a cleaner chart */}

        {/* Tooltips */}
        {chartData.map((point, index) => {
          const x = ((point.time.getTime() - minTime) / Math.max(timeRange, 1)) * chartWidth;
          const y = Math.max(0, Math.min(chartHeight, chartHeight - ((point.pnl - minPnl) / Math.max(range, 0.01)) * chartHeight));
          // Invert Y coordinate for tooltip positioning
          const invertedY = chartHeight - y;

          // Skip invalid coordinates
          if (isNaN(x) || isNaN(y)) {
            return null;
          }

          return (
            <div
              key={`tooltip-${index}`}
              id={`tooltip-${index}`}
              style={{
                position: 'absolute',
                left: `${80 + (x / chartWidth) * 100}%`,
                top: `${invertedY - 80}px`,
                transform: 'translateX(-50%)',
                background: 'rgba(15, 23, 42, 0.95)',
                border: '1px solid rgba(148, 163, 184, 0.3)',
                borderRadius: '8px',
                padding: '8px 12px',
                boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6)',
                color: '#e2e8f0',
                fontSize: '12px',
                pointerEvents: 'none',
                display: 'none',
                zIndex: 10,
                whiteSpace: 'nowrap',
                backdropFilter: 'blur(10px)',
                minWidth: '160px'
              }}
            >
              <div style={{ fontWeight: '600', marginBottom: '6px', color: '#f8fafc' }}>
                {formatTimeLabel(point.time, selectedInterval)}
              </div>
              <div style={{ color: '#cbd5e1', marginBottom: '4px', fontSize: '12px' }}>
                Total P&L: <span style={{ color: point.pnl >= 0 ? '#4ade80' : '#f87171', fontWeight: '600' }}>
                  {formatCurrency(point.pnl)}
                </span>
              </div>
              <div style={{ color: '#cbd5e1', marginBottom: '4px', fontSize: '12px' }}>
                Change: <span style={{ color: point.change >= 0 ? '#4ade80' : '#f87171', fontWeight: '600' }}>
                  {point.change >= 0 ? '+' : ''}{formatCurrency(point.change)}
                </span>
              </div>
              {selectedInterval !== 'live' && (
                <div style={{ color: '#94a3b8', fontSize: '11px' }}>
                  {point.tradeCount} trade{point.tradeCount !== 1 ? 's' : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PnlChart;

