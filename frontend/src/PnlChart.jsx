import { useState, useEffect, useMemo, useRef } from 'react';

const PnlChart = ({ trades, currentPrices = {}, bitgetPositions = {} }) => {
   const [selectedInterval, setSelectedInterval] = useState('live');
   const [liveData, setLiveData] = useState([]);
   const [tick, setTick] = useState(0);
   const [chartHeight, setChartHeight] = useState(250);
   const [chartWidth, setChartWidth] = useState(400);
   const [isMobile, setIsMobile] = useState(false);
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
         const marginX = isMobile ? 60 : 80;
         const marginY = isMobile ? 40 : 50;
         if (height > 0) setChartHeight(height - marginY);
         if (width > 0) setChartWidth(width - marginX);
       }
     };
     updateDimensions();
     window.addEventListener('resize', updateDimensions);
     return () => window.removeEventListener('resize', updateDimensions);
   }, [isMobile]);

  const intervals = [
    { key: 'live', label: 'LIVE' },
    { key: '1MIN', label: '1M' },
    { key: '15MIN', label: '15M' },
    { key: '30MIN', label: '30M' },
    { key: '1H', label: '1H' },
    { key: '1D', label: '1D' },
    { key: '1W', label: '1W' },
    { key: '1M', label: '1M' }
  ];

  const mapStatus = (s) => {
    if (!s) return 'other';
    const v = s.toLowerCase();
    if (v === 'placed') return 'open';
    if (v.includes('filled') || v.includes('closed') || v.includes('rejected') || v.includes('error') || v.includes('ignored') || v === 'signal') return 'closed';
    return 'other';
  };

  // Helper function to calculate P&L for a trade
  const calculateTradePnL = (trade) => {
    const statusKey = mapStatus(trade.status);

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
      const multiplier = trade.signal?.toUpperCase() === 'BUY' ? 1 : -1;

      if (!Number.isFinite(sizeValue)) {
        const sizeUsd = Number(trade.size_usd ?? trade.sizeUsd);
        if (Number.isFinite(sizeUsd) && Number.isFinite(entryPrice) && entryPrice !== 0) {
          sizeValue = sizeUsd / entryPrice;
        }
      }

      if (Number.isFinite(exitPrice) && Number.isFinite(entryPrice) && Number.isFinite(sizeValue)) {
        return (exitPrice - entryPrice) * sizeValue * multiplier;
      }
      return 0;
    } else {
      // For open trades, calculate based on current market price
      const entryPrice = Number(trade.price);
      let sizeValue = Number(trade.size);
      const multiplier = trade.signal?.toUpperCase() === 'BUY' ? 1 : -1;
      const currentPrice = Number(currentPrices[trade.symbol]);

      if (!Number.isFinite(sizeValue)) {
        const sizeUsd = Number(trade.size_usd ?? trade.sizeUsd);
        if (Number.isFinite(sizeUsd) && Number.isFinite(entryPrice) && entryPrice !== 0) {
          sizeValue = sizeUsd / entryPrice;
        }
      }

      if (Number.isFinite(currentPrice) && Number.isFinite(entryPrice) && Number.isFinite(sizeValue)) {
        return (currentPrice - entryPrice) * sizeValue * multiplier;
      }

      // Fallback to stored unrealized_pnl if available
      return Number(trade.unrealized_pnl || 0);
    }
  };

  // Calculate cumulative P&L for all trades
  const allCumulativePnls = useMemo(() => {
    const sorted = [...trades].sort((a, b) => a.created_at - b.created_at);
    const cumul = [];
    let total = 0;
    for (const trade of sorted) {
      total += calculateTradePnL(trade);
      cumul.push({ time: trade.created_at * 1000, pnl: total });
    }
    return cumul;
  }, [trades]);

  // Helper function to get total P&L at a specific time
  const getTotalPnLAtTime = (timeMs) => {
    // Find the last cumulative where time <= timeMs
    for (let i = allCumulativePnls.length - 1; i >= 0; i--) {
      if (allCumulativePnls[i].time <= timeMs) {
        return allCumulativePnls[i].pnl;
      }
    }
    return 0; // No trades before this time
  };

  // Calculate cumulative P&L over time with time-based aggregation
  const staticChartData = useMemo(() => {
    if (trades.length === 0) return [];

    // Sort trades by creation time
    const sortedTrades = [...trades].sort((a, b) => a.created_at - b.created_at);

    if (selectedInterval !== 'live') {
      // Aggregated mode: group trades by time intervals and create continuous data
      const intervalMs = {
        '1MIN': 60 * 1000,
        '15MIN': 15 * 60 * 1000,
        '30MIN': 30 * 60 * 1000,
        '1H': 60 * 60 * 1000,
        '1D': 24 * 60 * 60 * 1000,
        '1W': 7 * 24 * 60 * 60 * 1000,
        '1M': 30 * 24 * 60 * 60 * 1000
      };

      const bucketSize = intervalMs[selectedInterval];
      const buckets = new Map();

      // Find the time range
      const startTime = Math.min(...sortedTrades.map(t => t.created_at * 1000));
      const endTime = Math.max(...sortedTrades.map(t => t.created_at * 1000));
      const now = Date.now();

      // Create buckets for the entire time range
      const rangeEnd = Math.max(endTime, now);
      let currentTime = Math.floor(startTime / bucketSize) * bucketSize;

      while (currentTime <= rangeEnd) {
        buckets.set(currentTime, {
          time: currentTime,
          pnlChange: 0,
          tradeCount: 0,
          trades: []
        });
        currentTime += bucketSize;
      }

      // Add trades to their respective buckets
      sortedTrades.forEach((trade) => {
        const tradeTime = trade.created_at * 1000;
        const bucketStart = Math.floor(tradeTime / bucketSize) * bucketSize;
        const pnl = calculateTradePnL(trade);

        if (buckets.has(bucketStart)) {
          const bucket = buckets.get(bucketStart);
          bucket.pnlChange += pnl;
          bucket.tradeCount += 1;
          bucket.trades.push(trade);
        }
      });

      // Convert to cumulative data points
      const sortedBuckets = Array.from(buckets.entries())
        .sort(([a], [b]) => a - b);

      const data = [];
      let cumulativePnl = 0;

      sortedBuckets.forEach(([bucketTime, bucket], index) => {
        cumulativePnl += bucket.pnlChange;

        data.push({
          time: new Date(bucketTime),
          pnl: cumulativePnl,
          change: bucket.pnlChange,
          index,
          tradeCount: bucket.tradeCount,
          hasTrades: bucket.tradeCount > 0
        });
      });

      return data;
    }
  }, [trades, selectedInterval, currentPrices, bitgetPositions]);

  // Live data calculation - show only last 5 minutes of data
  useEffect(() => {
    if (selectedInterval !== 'live') return;

    const sortedTrades = [...trades].sort((a, b) => a.created_at - b.created_at);
    const now = Date.now() / 1000;
    const fiveMinutesAgo = now - (5 * 60); // 5 minutes in seconds

    // For live mode, show compressed time view - last 5 minutes at 15-second intervals
    const data = [];
    let cumulativePnl = 0;

    if (sortedTrades.length === 0) {
      // No trades at all
      setLiveData([]);
      return;
    }

    // Get trades from last 5 minutes
    const recentTrades = sortedTrades.filter(trade => trade.created_at >= fiveMinutesAgo);

    if (recentTrades.length === 0) {
      // No recent trades, show last 5 trades for context
      const lastTrades = sortedTrades.slice(-5);
      lastTrades.forEach((trade, index) => {
        const pnl = getTotalPnLAtTime(trade.created_at * 1000);
        const change = index === 0 ? pnl : pnl - data[data.length - 1].pnl;

        data.push({
          time: new Date(trade.created_at * 1000),
          pnl: pnl,
          change: change,
          index,
          tradeCount: 1
        });
      });
    } else {
      // Group recent trades into 15-second buckets for better visualization
      const bucketSize = 15; // 15 seconds
      const buckets = new Map();

      recentTrades.forEach(trade => {
        const bucketTime = Math.floor(trade.created_at / bucketSize) * bucketSize;
        if (!buckets.has(bucketTime)) {
          buckets.set(bucketTime, { trades: [], time: bucketTime });
        }
        buckets.get(bucketTime).trades.push(trade);
      });

      // Create data points from buckets
      const sortedBuckets = Array.from(buckets.entries()).sort(([a], [b]) => a - b);

      sortedBuckets.forEach(([bucketTime, bucket], index) => {
        const pnl = getTotalPnLAtTime(bucketTime * 1000);
        const change = index === 0 ? pnl : pnl - data[data.length - 1].pnl;

        data.push({
          time: new Date(bucketTime * 1000),
          pnl: pnl,
          change: change,
          index: data.length,
          tradeCount: bucket.trades.length
        });
      });
    }

    // For live mode, add dummy points at the start and end of the 5-minute window to make the line span full width
    if (selectedInterval === 'live' && data.length > 0) {
      const now = Date.now();
      const fiveMinutesMs = 5 * 60 * 1000;
      const minTime = now - fiveMinutesMs;
      const maxTime = now;

      // Add start point if the first data point is not at the beginning of the window
      if (data[0].time.getTime() > minTime + 1000) { // small buffer
        const pnl = getTotalPnLAtTime(minTime);
        data.unshift({
          time: new Date(minTime),
          pnl: pnl,
          change: 0,
          index: -1,
          tradeCount: 0
        });
      }

      // Add end point if the last data point is not at the current time
      if (data[data.length - 1].time.getTime() < maxTime - 1000) { // small buffer
        const pnl = getTotalPnLAtTime(maxTime);
        data.push({
          time: new Date(maxTime),
          pnl: pnl,
          change: 0,
          index: data.length,
          tradeCount: 0
        });
      }
    }

    setLiveData(data);
  }, [trades, currentPrices, bitgetPositions, tick]);

  const chartData = selectedInterval === 'live' ? liveData : staticChartData;

  const formatCurrency = (value) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
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

  if (chartData.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '350px',
        color: 'rgba(148, 163, 184, 0.7)',
        fontSize: '14px'
      }}>
        {/* Interval selector */}
        <div style={{
          display: 'flex',
          gap: isMobile ? '4px' : '8px',
          marginBottom: '20px',
          flexWrap: 'wrap',
          justifyContent: 'center'
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
  let timeRange = maxTime - minTime || 1;

  // For live mode, force the time range to be the full 5-minute window plus buffer to expand the line across the X-axis
  if (selectedInterval === 'live') {
    const now = Date.now();
    const fiveMinutesMs = 5 * 60 * 1000;
    const bufferMs = 30 * 1000; // 30 seconds buffer for future
    minTime = now - fiveMinutesMs;
    maxTime = now + bufferMs;
    timeRange = maxTime - minTime;
  } else {
    // For other modes, set maxTime to now for relative time display
    maxTime = Date.now();
    timeRange = maxTime - minTime;
  }

  // Simple HTML/CSS chart implementation
  const allPnls = chartData.map(d => d.pnl);
  let minPnl = Math.min(...allPnls);
  let maxPnl = Math.max(...allPnls);
  let range = maxPnl - minPnl || 1;

  // Add padding to Y-axis range
  if (chartData.length > 0) {
    const padding = Math.max((maxPnl - minPnl) * 0.1, 1); // 10% padding or minimum 1 USD
    minPnl = minPnl - padding;
    maxPnl = maxPnl + padding;
    range = maxPnl - minPnl;
  }

  return (
    <div ref={chartRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {/* Interval selector */}
      <div style={{
        display: 'flex',
        gap: isMobile ? '4px' : '8px',
        marginBottom: isMobile ? '8px' : '10px',
        flexWrap: 'wrap',
        justifyContent: 'center'
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
      </div>

      <div style={{
        position: 'relative',
        width: '100%',
        height: 'calc(100% - 50px)', // Increased chart area
        borderLeft: '2px solid rgba(148, 163, 184, 0.4)',
        borderBottom: '2px solid rgba(148, 163, 184, 0.4)',
        borderRadius: '8px',
        background: 'linear-gradient(180deg, rgba(15, 23, 42, 0.3) 0%, rgba(15, 23, 42, 0.1) 100%)',
        boxShadow: 'inset 0 0 20px rgba(0, 0, 0, 0.1)'
      }}>
        {/* Y-axis labels */}
        <div style={{
          position: 'absolute',
          left: '5px',
          top: '0',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          fontSize: isMobile ? '10px' : '11px',
          color: 'rgba(148, 163, 184, 0.8)',
          padding: '0 4px',
          width: isMobile ? '50px' : '60px',
          zIndex: 10,
          pointerEvents: 'none'
        }}>
          <div style={{ fontSize: isMobile ? '8px' : '9px', color: 'rgba(148, 163, 184, 0.6)', marginBottom: '4px' }}>
            Updated: {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: 'right',
            width: '100%',
            fontWeight: '500'
          }}>
            {formatCurrency(maxPnl)}
          </span>
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: 'right',
            width: '100%',
            fontWeight: '500'
          }}>
            {formatCurrency((maxPnl + minPnl) / 2)}
          </span>
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: 'right',
            width: '100%',
            fontWeight: '500'
          }}>
            {formatCurrency(minPnl)}
          </span>
        </div>

        {/* Chart area */}
        <div style={{
          position: 'absolute',
          left: isMobile ? '60px' : '80px',
          top: '0',
          right: '0',
          bottom: isMobile ? '20px' : '15px', // Increased for mobile X-axis visibility
          overflow: 'hidden'
        }}>
          <svg width="100%" height="100%" viewBox={`0 0 ${chartWidth} ${chartHeight}`} style={{ overflow: 'visible' }}>
          <defs>
            <linearGradient id="pnlGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#60a5fa" stopOpacity="0.2" />
            </linearGradient>
            <linearGradient id="positiveGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#4ade80" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#4ade80" stopOpacity="0.3" />
            </linearGradient>
            <linearGradient id="negativeGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#f87171" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#f87171" stopOpacity="0.3" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          <line x1="0" y1="0" x2={chartWidth} y2="0" stroke="rgba(148, 163, 184, 0.3)" strokeWidth="1" strokeDasharray="3,3" />
          <line x1="0" y1={chartHeight/2} x2={chartWidth} y2={chartHeight/2} stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="3,3" />
          <line x1="0" y1={chartHeight} x2={chartWidth} y2={chartHeight} stroke="rgba(148, 163, 184, 0.3)" strokeWidth="1" strokeDasharray="3,3" />
          {/* Vertical grid lines */}
          <line x1="0" y1="0" x2="0" y2={chartHeight} stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="3,3" />
          <line x1={chartWidth/4} y1="0" x2={chartWidth/4} y2={chartHeight} stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="3,3" />
          <line x1={chartWidth/2} y1="0" x2={chartWidth/2} y2={chartHeight} stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="3,3" />
          <line x1={3*chartWidth/4} y1="0" x2={3*chartWidth/4} y2={chartHeight} stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="3,3" />
          <line x1={chartWidth} y1="0" x2={chartWidth} y2={chartHeight} stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="3,3" />

          {/* Area fill based on P&L sign */}
          <polygon
            fill={chartData.length > 0 && chartData[chartData.length - 1].pnl >= 0 ? "url(#positiveGradient)" : "url(#negativeGradient)"}
            stroke="none"
            points={`0,${chartHeight} ${chartData.map((point, index) => {
              const x = ((point.time.getTime() - minTime) / timeRange) * chartWidth;
              const y = Math.max(0, Math.min(chartHeight, chartHeight - ((point.pnl - minPnl) / range) * chartHeight));
              return `${x},${y}`;
            }).join(' ')} ${selectedInterval === 'live' ? ((Date.now() - minTime) / timeRange) * chartWidth : chartWidth},${chartHeight}`}
          />

          {/* P&L line segments with color based on P&L */}
          {chartData.map((point, index) => {
            if (index === 0) return null;
            const prevPoint = chartData[index - 1];
            const x1 = ((prevPoint.time.getTime() - minTime) / timeRange) * chartWidth;
            const y1 = Math.max(0, Math.min(chartHeight, chartHeight - ((prevPoint.pnl - minPnl) / range) * chartHeight));
            const x2 = ((point.time.getTime() - minTime) / timeRange) * chartWidth;
            const y2 = Math.max(0, Math.min(chartHeight, chartHeight - ((point.pnl - minPnl) / range) * chartHeight));
            const isPositive = point.pnl >= 0;

            return (
              <line
                key={`line-${index}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={isPositive ? '#4ade80' : '#f87171'}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}

          {/* Circular dot at the last point for LIVE mode */}
          {selectedInterval === 'live' && chartData.length > 0 && (
            <>
              <circle
                cx={((Date.now() - minTime) / timeRange) * chartWidth}
                cy={Math.max(8, Math.min(chartHeight - 8, chartHeight - ((chartData[chartData.length - 1].pnl - minPnl) / range) * chartHeight))}
                r="6"
                fill={chartData[chartData.length - 1].pnl >= 0 ? '#4ade80' : '#f87171'}
                stroke="#ffffff"
                strokeWidth="2"
                style={{ filter: 'drop-shadow(0 0 6px rgba(0,0,0,0.3))', animation: 'pulse 1s infinite' }}
              />
              {/* Invisible hover area for the dot */}
              <circle
                cx={((Date.now() - minTime) / timeRange) * chartWidth}
                cy={Math.max(8, Math.min(chartHeight - 8, chartHeight - ((chartData[chartData.length - 1].pnl - minPnl) / range) * chartHeight))}
                r="10"
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  const tooltip = e.target.parentElement.querySelector(`#tooltip-${chartData.length - 1}`);
                  if (tooltip) tooltip.style.display = 'block';
                }}
                onMouseLeave={(e) => {
                  const tooltip = e.target.parentElement.querySelector(`#tooltip-${chartData.length - 1}`);
                  if (tooltip) tooltip.style.display = 'none';
                }}
              />
            </>
          )}

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
            const x1 = ((prevPoint.time.getTime() - minTime) / timeRange) * chartWidth;
            const y1 = chartHeight - ((prevPoint.pnl - minPnl) / range) * chartHeight;
            const x2 = ((point.time.getTime() - minTime) / timeRange) * chartWidth;
            const y2 = chartHeight - ((point.pnl - minPnl) / range) * chartHeight;

            // Create hover area for this line segment
            const midX = (x1 + x2) / 2;
            const midY = (y1 + y2) / 2;

            return (
              <rect
                key={`hover-${index}`}
                x={midX - 2}
                y={Math.min(y1, y2) - 8}
                width="4"
                height={Math.abs(y2 - y1) + 16}
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

        {/* X-axis labels */}
        <div style={{
          position: 'absolute',
          bottom: '0',
          left: isMobile ? '60px' : '80px',
          right: '0',
          height: isMobile ? '18px' : '15px', // Increased height for mobile
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: isMobile ? '9px' : '11px', // Slightly smaller font for mobile
          color: '#94a3b8',
          padding: '0 2px', // Reduced padding for mobile
          fontWeight: '500',
          zIndex: 10,
          background: isMobile ? 'rgba(15, 23, 42, 0.8)' : 'transparent', // Background for mobile visibility
          borderRadius: isMobile ? '4px' : '0'
        }}>
          {selectedInterval === 'live' ? (
            // For live mode, show relative time labels - fewer for mobile
            (isMobile ? [5, 3, 1, 0] : [5, 4, 3, 2, 1, 0]).map((minutesAgo) => {
              const timeMs = maxTime - minutesAgo * 60 * 1000;
              const label = minutesAgo === 0 ? 'now' : `${minutesAgo}m ago`;
              return (
                <span key={minutesAgo} style={{ margin: isMobile ? '0 1px' : '0 2px' }}>
                  {label}
                </span>
              );
            })
          ) : (
            // For other modes, show absolute time labels at start, middle, end
            [0, 0.5, 1].map((fraction) => {
              const timeAtFraction = minTime + fraction * timeRange;
              const label = formatTimeLabel(new Date(timeAtFraction), selectedInterval);
              return (
                <span key={fraction} style={{ margin: isMobile ? '0 1px' : '0 2px' }}>
                  {label}
                </span>
              );
            })
          )}
        </div>

        {/* Tooltips */}
        {chartData.map((point, index) => {
          const x = ((point.time.getTime() - minTime) / timeRange) * chartWidth;
          const y = chartHeight - ((point.pnl - minPnl) / range) * chartHeight;
          return (
            <div
              key={`tooltip-${index}`}
              id={`tooltip-${index}`}
              style={{
                position: 'absolute',
                left: `${80 + (x / chartWidth) * 100}%`,
                top: `${y - 80}px`,
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