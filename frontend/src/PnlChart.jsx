import { useMemo } from 'react';

const PnlChart = ({ trades }) => {
  // Calculate cumulative P&L over time
  const chartData = useMemo(() => {
    const data = [];
    let cumulativePnl = 0;

    // Sort trades by creation time
    const sortedTrades = [...trades].sort((a, b) => a.created_at - b.created_at);

    sortedTrades.forEach((trade, index) => {
      const pnl = (trade.realized_pnl || 0) + (trade.unrealized_pnl || 0);
      cumulativePnl += pnl;

      data.push({
        time: new Date(trade.created_at * 1000).toLocaleDateString(),
        pnl: cumulativePnl,
        change: pnl,
        index
      });
    });

    return data;
  }, [trades]);

  const formatCurrency = (value) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  };

  if (chartData.length === 0) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '300px',
        color: 'rgba(148, 163, 184, 0.7)',
        fontSize: '14px'
      }}>
        No trade data available for P&L chart
      </div>
    );
  }

  // Simple HTML/CSS chart implementation
  const minPnl = Math.min(...chartData.map(d => d.pnl));
  const maxPnl = Math.max(...chartData.map(d => d.pnl));
  const range = maxPnl - minPnl || 1;
  const chartHeight = 250;
  const chartWidth = 100;

  return (
    <div style={{ width: '100%', height: '300px', padding: '20px' }}>
      <div style={{
        position: 'relative',
        width: '100%',
        height: `${chartHeight}px`,
        borderLeft: '1px solid rgba(148, 163, 184, 0.3)',
        borderBottom: '1px solid rgba(148, 163, 184, 0.3)',
        marginBottom: '30px'
      }}>
        {/* Y-axis labels */}
        <div style={{
          position: 'absolute',
          left: '-50px',
          top: '0',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          fontSize: '10px',
          color: 'rgba(148, 163, 184, 0.7)',
          padding: '0 2px',
          width: '45px'
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right', width: '100%' }}>
            {formatCurrency(maxPnl)}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right', width: '100%' }}>
            {formatCurrency(minPnl)}
          </span>
        </div>

        {/* Chart area */}
        <svg width="100%" height="100%" style={{ overflow: 'visible' }}>
          <defs>
            <linearGradient id="pnlGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#60a5fa" stopOpacity="0.3" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          <line x1="0" y1="0" x2="100%" y2="0" stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="2,2" />
          <line x1="0" y1="50%" x2="100%" y2="50%" stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="2,2" />
          <line x1="0" y1="100%" x2="100%" y2="100%" stroke="rgba(148, 163, 184, 0.2)" strokeWidth="1" strokeDasharray="2,2" />

          {/* P&L line */}
          <polyline
            fill="none"
            stroke="#60a5fa"
            strokeWidth="2"
            points={
              chartData.map((point, index) => {
                const x = (index / (chartData.length - 1)) * 100;
                const y = chartHeight - ((point.pnl - minPnl) / range) * chartHeight;
                return `${x}%,${y}`;
              }).join(' ')
            }
          />

          {/* Colored line segments */}
          {chartData.map((point, index) => {
            if (index === 0) return null;
            const prevPoint = chartData[index - 1];
            const x1 = ((index - 1) / (chartData.length - 1)) * 100;
            const y1 = chartHeight - ((prevPoint.pnl - minPnl) / range) * chartHeight;
            const x2 = (index / (chartData.length - 1)) * 100;
            const y2 = chartHeight - ((point.pnl - minPnl) / range) * chartHeight;
            const isPositive = point.pnl >= 0;

            return (
              <line
                key={`line-${index}`}
                x1={`${x1}%`}
                y1={y1}
                x2={`${x2}%`}
                y2={y2}
                stroke={isPositive ? '#4ade80' : '#f87171'}
                strokeWidth="3"
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

        {/* Tooltips */}
        {chartData.map((point, index) => {
          const x = (index / (chartData.length - 1)) * 100;
          const y = chartHeight - ((point.pnl - minPnl) / range) * chartHeight;
          return (
            <div
              key={`tooltip-${index}`}
              id={`tooltip-${index}`}
              style={{
                position: 'absolute',
                left: `${x}%`,
                top: `${y - 60}px`,
                transform: 'translateX(-50%)',
                background: 'rgba(15, 23, 42, 0.95)',
                border: '1px solid rgba(148, 163, 184, 0.2)',
                borderRadius: '8px',
                padding: '8px 12px',
                boxShadow: '0 10px 20px rgba(0, 0, 0, 0.5)',
                color: '#e2e8f0',
                fontSize: '12px',
                pointerEvents: 'none',
                display: 'none',
                zIndex: 10,
                whiteSpace: 'nowrap'
              }}
            >
              <div style={{ fontWeight: '600', marginBottom: '4px' }}>{point.time}</div>
              <div style={{ color: '#f8fafc', marginBottom: '2px' }}>
                Total P&L: {formatCurrency(point.pnl)}
              </div>
              <div style={{ color: point.change >= 0 ? '#4ade80' : '#f87171' }}>
                Trade Change: {point.change >= 0 ? '+' : ''}{formatCurrency(point.change)}
              </div>
            </div>
          );
        })}
      </div>

      {/* X-axis labels */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginTop: '10px',
        fontSize: '11px',
        color: 'rgba(148, 163, 184, 0.7)',
        padding: '0 5px'
      }}>
        {chartData.filter((_, index) => index % Math.ceil(chartData.length / 5) === 0).map((point, index) => (
          <span key={index} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '80px' }}>
            {point.time}
          </span>
        ))}
      </div>
    </div>
  );
};

export default PnlChart;