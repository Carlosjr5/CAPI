function fmtTime(t){ return new Date(t*1000).toLocaleString() }

function getStatusClass(s){
  if(!s) return ''
  const v = s.toLowerCase()
  if(v === 'placed') return 'status-open'
  if(v === 'closed') return 'status-closed'
  if(v === 'signal') return 'status-signal'
  if(v === 'received') return 'status-pending'
  if(v.includes('error') || v.includes('rejected')) return 'status-error'
  return ''
}

function derivePnL(trade, calculatePnL){
  if(!trade) return { value: null, tone: 'neutral' }
  const statusRaw = (trade.status || '').toLowerCase()
  let value = null

  if (statusRaw === 'placed') {
    if (typeof calculatePnL === 'function') {
      const current = calculatePnL(trade)
      if (Number.isFinite(current)) {
        value = current
      }
    }
  } else if (statusRaw.includes('closed') || statusRaw.includes('filled')) {
    const raw = trade.realized_pnl ?? trade.realizedPnl
    if (raw !== undefined && raw !== null && Number.isFinite(Number(raw))) {
      value = Number(raw)
    } else {
      const exitPrice = Number(trade.exit_price ?? trade.exitPrice)
      const entryPrice = Number(trade.price)
      const sizeValue = Number(trade.size)
      if (Number.isFinite(exitPrice) && Number.isFinite(entryPrice) && Number.isFinite(sizeValue)) {
        const direction = (trade.signal || '').toUpperCase() === 'BUY' || (trade.signal || '').toUpperCase() === 'LONG' ? 1 : -1
        value = (exitPrice - entryPrice) * sizeValue * direction
      }
    }
  }

  let tone = 'neutral'
  if (Number.isFinite(value)) {
    if (value > 0) tone = 'positive'
    else if (value < 0) tone = 'negative'
  } else {
    value = null
  }

  return { value, tone }
}

function formatPriceCell(price){
  const numeric = Number(price)
  return Number.isFinite(numeric) ? numeric.toFixed(2) : '-'
}

export default function TradeTable({items, onRefresh, calculatePnL, formatCurrency}){
  return (
    <div className="card table-card">
      <div className="toolbar">
        <button onClick={onRefresh}>Refresh</button>
      </div>
      <div className="table-scroller" tabIndex={0} aria-label="Trade history">
        <table className="trades">
          <thead><tr><th>When</th><th>Symbol</th><th>Signal</th><th>Price</th><th>PnL</th><th>Status</th></tr></thead>
          <tbody>
            {items.map(it=> {
              const { value, tone } = derivePnL(it, calculatePnL)
              const hasValue = typeof value === 'number' && Number.isFinite(value)
              const display = hasValue
                ? (typeof formatCurrency === 'function' ? formatCurrency(value) : value.toFixed(2))
                : '—'

              return (
                <tr key={it.id}>
                  <td className="muted">{fmtTime(it.created_at)}</td>
                  <td><strong>{it.symbol}</strong><div className="muted id">{it.id?.slice(0,10)}</div></td>
                  <td>{it.signal}</td>
                  <td>{formatPriceCell(it.price)}</td>
                  <td className={`pnl-cell pnl-${tone}`}>{display}</td>
                  <td className={getStatusClass(it.status)}>{(it.status||'').toLowerCase()}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
