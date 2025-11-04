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

export default function TradeTable({items, onRefresh}){
  return (
    <div className="card">
      <div className="toolbar">
        <button onClick={onRefresh}>Refresh</button>
      </div>
      <table className="trades">
        <thead><tr><th>When</th><th>Symbol</th><th>Signal</th><th>Price</th><th>Status</th></tr></thead>
        <tbody>
          {items.map(it=> (
            <tr key={it.id}>
              <td className="muted">{fmtTime(it.created_at)}</td>
              <td><strong>{it.symbol}</strong><div className="muted id">{it.id?.slice(0,10)}</div></td>
              <td>{it.signal}</td>
              <td>{it.price!=null? Number(it.price).toFixed(2):'-'}</td>
              <td className={getStatusClass(it.status)}>{(it.status||'').toLowerCase()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
