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

export default function TradeTable({items, onRefresh, calculatePnL, formatCurrency, currentPrices}){
  return (
    <div className="card table-card">
      <div className="toolbar">
        <button onClick={onRefresh}>Refresh</button>
      </div>
      <div className="table-scroller" tabIndex={0} aria-label="Trade history">
        <table className="trades">
          <thead><tr><th>When</th><th>Symbol</th><th>Signal</th><th>Price</th><th>Size</th><th>PnL</th><th>Status</th></tr></thead>
          <tbody>
            {items.map(it=> {
              const pnlValue = calculatePnL ? calculatePnL(it, currentPrices) : null
              const pnlDisplay = pnlValue !== null && pnlValue !== undefined ? formatCurrency(pnlValue) : '-'
              const pnlClass = pnlValue !== null && pnlValue !== undefined ? (pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : '') : ''

              // Show PnL for all positions - open and closed
              let showPnL = true

              return (
                <tr key={it.id}>
                  <td className="muted" data-label="When">{fmtTime(it.created_at)}</td>
                  <td className="symbol-cell" data-label="Symbol">
                    <strong>{it.symbol}</strong>
                    <div className="muted id">{it.id?.slice(0,10)}</div>
                  </td>
                  <td data-label="Signal">{it.signal}</td>
                  <td data-label="Price">{it.price!=null? Number(it.price).toFixed(2):'-'}</td>
                  <td data-label="Size">{it.size!=null? Number(it.size).toFixed(4):'-'}</td>
                  <td className={pnlClass} data-label="PnL">{showPnL ? pnlDisplay : '-'}</td>
                  <td className={getStatusClass(it.status)} data-label="Status">{(it.status||'').toLowerCase()}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
