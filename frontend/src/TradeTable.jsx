import React, { useState } from 'react'

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

function getDisplaySignal(signal) {
  if (!signal) return signal;
  const upper = signal.toUpperCase();
  // Normalize common variants to LONG/SHORT for display
  if (upper === 'LONG' || upper === 'BUY') return 'LONG';
  if (upper === 'SHORT' || upper === 'SELL') return 'SHORT';
  return signal;
}

function calculateROE(it, pnlValue, currentPrices, bitgetPositions) {
  // ROE comes directly from Bitget position data - no calculations
  const normalizedKey = (it.symbol || '').replace(/[^A-Z0-9]/gi, '').toUpperCase()
  const bitgetPosition = bitgetPositions?.[normalizedKey]

  if (bitgetPosition?.found && bitgetPosition.pnlRatio !== null && bitgetPosition.pnlRatio !== undefined) {
    return parseFloat(bitgetPosition.pnlRatio) * 100
  }

  return null
}

const ITEMS_PER_PAGE = 10

export default function TradeTable({items, onRefresh, calculatePnL, formatCurrency, currentPrices, bitgetPositions, isAdmin = false, authHeaders = () => ({}), buildApiUrl = (p) => p}){
  const [currentPage, setCurrentPage] = useState(1)
  const [symbolFilter, setSymbolFilter] = useState('ALL')
  const [sortBy, setSortBy] = useState(null)
  const [sortDir, setSortDir] = useState('asc')

  // Build a list of unique symbols for the symbol filter dropdown
  const uniqueSymbols = Array.from(new Set((items || []).map(it => (it && it.symbol) || '').filter(s => !!s))).sort()

  // Symbol options shown in the header filter (explicit set as requested)
  const SYMBOL_OPTIONS = ['ALL', 'BTC', 'ETH', 'SOL', 'XRP']

  // Compute a displayStatus for each trade based on DB status and Bitget snapshot.
  // If Bitget reports a live position on the same symbol but with the opposite side,
  // treat the DB open trade as closed for display purposes (avoids showing the old
  // same-symbol opposite-side as still "placed").
  const processedItems = (items || []).map(it => {
    if (!it) return it
    const originalStatus = (it.status || '').toLowerCase()
    let displayStatus = originalStatus

    // Only consider reconciling open/placed trades
    if (originalStatus === 'placed' || originalStatus === 'open') {
      const key = (it.symbol || '').replace(/[^A-Z0-9]/gi, '').toUpperCase()
      const bp = bitgetPositions?.[key]
      try {
        if (bp && bp.found) {
          const bitgetSide = (bp.side || '').toUpperCase()
          const tradeSideRaw = (it.signal || '').toUpperCase()
          const tradeSide = tradeSideRaw === 'BUY' || tradeSideRaw === 'LONG' ? 'LONG' : tradeSideRaw === 'SELL' || tradeSideRaw === 'SHORT' ? 'SHORT' : tradeSideRaw
          if (bitgetSide && tradeSide && bitgetSide !== tradeSide) {
            // Bitget currently has the opposite side -> mark DB trade as closed for display
            displayStatus = 'closed'
          } else if (bitgetSide && tradeSide && bitgetSide === tradeSide) {
            displayStatus = 'placed'
          }
        }
      } catch (e) {
        // In case bitgetPositions structure differs, fall back to original status
        displayStatus = originalStatus
      }
    }

    return { ...it, displayStatus }
  })

  // Filter to show only actual opened trades (placed or closed) and normalize signals to LONG/SHORT
  let filteredItems = processedItems.filter(it => {
    if (!it) return false
    const status = (it.displayStatus || it.status || '').toLowerCase()
    if (!(status === 'placed' || status === 'closed')) return false
    const sig = (it.signal || '').toUpperCase()
    // Accept only LONG/SHORT or BUY/SELL (we will normalize BUY->LONG, SELL->SHORT)
    return sig === 'LONG' || sig === 'SHORT' || sig === 'BUY' || sig === 'SELL'
  })

  // Apply symbol filter if set (match by prefix, e.g. BTC -> BTCUSDT)
  if (symbolFilter && symbolFilter !== 'ALL') {
    filteredItems = filteredItems.filter(it => {
      const sym = (it.symbol || '').toUpperCase()
      return sym.startsWith(symbolFilter.toUpperCase())
    })
  }

  // Sorting helper
  const handleSort = (key) => {
    if (sortBy === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(key)
      setSortDir('asc')
    }
    setCurrentPage(1)
  }

  const compareValues = (a, b, key) => {
    const vA = (() => {
      if (!a) return ''
      if (key === 'created_at') return Number(a.created_at) || 0
      if (key === 'symbol') return (a.symbol || '').toUpperCase()
      if (key === 'signal') return (getDisplaySignal(a.signal) || '').toUpperCase()
      if (key === 'price') return Number(a.price) || 0
      if (key === 'size_usd') return Number(a.size_usd) || 0
      if (key === 'pnl') return Number(calculatePnL ? calculatePnL(a, currentPrices) : 0) || 0
      if (key === 'status') return ((a.displayStatus || a.status) || '').toUpperCase()
      return ''
    })()
    const vB = (() => {
      if (!b) return ''
      if (key === 'created_at') return Number(b.created_at) || 0
      if (key === 'symbol') return (b.symbol || '').toUpperCase()
      if (key === 'signal') return (getDisplaySignal(b.signal) || '').toUpperCase()
      if (key === 'price') return Number(b.price) || 0
      if (key === 'size_usd') return Number(b.size_usd) || 0
      if (key === 'pnl') return Number(calculatePnL ? calculatePnL(b, currentPrices) : 0) || 0
      if (key === 'status') return ((b.displayStatus || b.status) || '').toUpperCase()
      return ''
    })()

    if (typeof vA === 'number' && typeof vB === 'number') return vA - vB
    return vA > vB ? 1 : vA < vB ? -1 : 0
  }

  // Apply sorting
  if (sortBy) {
    filteredItems = [...filteredItems].sort((a, b) => {
      const comp = compareValues(a, b, sortBy)
      return sortDir === 'asc' ? comp : -comp
    })
  }

  // Calculate pagination based on filtered items
  const totalItems = filteredItems.length
  const totalPages = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE))
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE
  const endIndex = startIndex + ITEMS_PER_PAGE
  const currentItems = filteredItems.slice(startIndex, endIndex)

  const goToPage = (page) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page)
    }
  }

  const goToPrevious = () => {
    goToPage(currentPage - 1)
  }

  const goToNext = () => {
    goToPage(currentPage + 1)
  }

  return (
    <div className="card table-card">
      <div className="toolbar">
        <button onClick={onRefresh} className="refresh-btn">
          <span className="refresh-icon">🔄</span>
          Refresh
        </button>
        {totalPages > 1 && (
          <div className="pagination-info">
            Page {currentPage} of {totalPages} ({totalItems} total)
          </div>
        )}
      </div>
      <div className="table-scroller" tabIndex={0} aria-label="Trade history">
        <table className="trades">
          <thead>
            <tr>
              <th onClick={() => handleSort('created_at')} style={{cursor:'pointer', textAlign: 'center'}}>When {sortBy === 'created_at' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</th>
              <th style={{textAlign: 'center'}}>
                <div style={{display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8}}>
                  <div onClick={() => handleSort('symbol')} style={{cursor:'pointer', userSelect: 'none'}}>Symbol {sortBy === 'symbol' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</div>
                  <select
                    value={symbolFilter}
                    onChange={(e) => { setSymbolFilter(e.target.value); setCurrentPage(1); }}
                    style={{
                      marginLeft: 6,
                      padding: '4px 6px',
                      fontSize: '0.75rem',
                      height: 28,
                      lineHeight: '1',
                      borderRadius: 4,
                      background: '#0f172a',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.06)'
                    }}
                  >
                    {SYMBOL_OPTIONS.map(s => (<option key={s} value={s}>{s}</option>))}
                  </select>
                </div>
              </th>
              <th onClick={() => handleSort('signal')} style={{cursor:'pointer', textAlign: 'center'}}>Signal {sortBy === 'signal' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</th>
              <th onClick={() => handleSort('price')} style={{cursor:'pointer', textAlign: 'center'}}>Price {sortBy === 'price' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</th>
              <th onClick={() => handleSort('size_usd')} style={{cursor:'pointer', textAlign: 'center'}}>Size (USD) {sortBy === 'size_usd' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</th>
              <th onClick={() => handleSort('pnl')} style={{cursor:'pointer', textAlign: 'center'}}>PnL {sortBy === 'pnl' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</th>
              <th onClick={() => handleSort('status')} style={{cursor:'pointer', textAlign: 'center'}}>Status {sortBy === 'status' ? (sortDir === 'asc' ? '▲' : '▼') : ''}</th>
              {isAdmin && <th style={{textAlign: 'center'}}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {currentItems.map(it=> {
              const pnlValue = calculatePnL ? calculatePnL(it, currentPrices) : null
              const pnlDisplay = pnlValue !== null && pnlValue !== undefined ? formatCurrency(pnlValue) : '-'
              const pnlClass = pnlValue !== null && pnlValue !== undefined ? (pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : '') : ''

              // Calculate ROE%
              const roeValue = calculateROE(it, pnlValue, currentPrices, bitgetPositions)
              const roeDisplay = roeValue !== null && roeValue !== undefined ? `${roeValue.toFixed(2)}%` : ''
              const roeClass = roeValue !== null && roeValue !== undefined ? (roeValue > 0 ? 'positive' : roeValue < 0 ? 'negative' : '') : ''

              // Show PnL for all positions - open and closed
              let showPnL = true

              return (
                <tr key={it.id}>
                  {(() => {
                    const displayStatus = (it.displayStatus || it.status || '').toLowerCase()
                    return (
                      <>
                        <td className="muted" data-label="When" style={{textAlign: 'center'}}>{fmtTime(it.created_at)}</td>
                        <td className="symbol-cell" data-label="Symbol" style={{textAlign: 'center'}}>
                          <strong>{it.symbol}</strong>
                          <div className="muted id">{it.id?.slice(0,10)}</div>
                        </td>
                        <td data-label="Signal" style={{textAlign: 'center'}}>
                          <span className={`signal-tag ${getDisplaySignal(it.signal) === 'LONG' ? 'signal-long' : getDisplaySignal(it.signal) === 'SHORT' ? 'signal-short' : ''}`}>
                            {getDisplaySignal(it.signal)}
                          </span>
                        </td>
                        <td data-label="Price" style={{textAlign: 'center'}}>{it.price!=null? Number(it.price).toFixed(2):'-'}</td>
                        <td data-label="Size (USD)" style={{textAlign: 'center'}}>{it.size_usd!=null? formatCurrency(it.size_usd):'-'}</td>
                        <td className={pnlClass} data-label="PnL" style={{textAlign: 'center'}}>
                          <div>{showPnL ? pnlDisplay : '-'}</div>
                        </td>
                        <td className={getStatusClass(displayStatus)} data-label="Status" style={{textAlign: 'center'}}>{displayStatus}</td>
                                  {isAdmin && (
                                    <td style={{textAlign: 'center'}}>
                                      <div style={{display: 'flex', gap: 8, justifyContent: 'center'}}>
                                        <button
                                          type="button"
                                          className="close-btn"
                                          onClick={async () => {
                                            if (!confirm('Close this position on Bitget?')) return
                                            try {
                                              const res = await fetch(buildApiUrl(`/close/${it.id}`), { method: 'POST', headers: authHeaders() })
                                              if (res.ok) {
                                                try { onRefresh && onRefresh() } catch(e){}
                                                alert('Position closed successfully')
                                              } else {
                                                const txt = await res.text()
                                                alert('Failed to close: ' + res.status + ' ' + txt)
                                              }
                                            } catch (error) {
                                              alert('Error closing position: ' + (error.message || error))
                                            }
                                          }}
                                          style={{padding: '6px 8px', fontSize: '0.8rem'}}
                                        >
                                          Close
                                        </button>
                                        <button
                                          type="button"
                                          className="delete-btn"
                                          onClick={async () => {
                                            if (!confirm('Delete this trade from the database? This cannot be undone.')) return
                                            try {
                                              const res = await fetch(buildApiUrl(`/admin/delete-trade/${it.id}`), { method: 'POST', headers: authHeaders() })
                                              if (res.ok) {
                                                try { onRefresh && onRefresh() } catch(e){}
                                                alert('Trade deleted')
                                              } else {
                                                const txt = await res.text()
                                                alert('Failed to delete: ' + res.status + ' ' + txt)
                                              }
                                            } catch (error) {
                                              alert('Error deleting trade: ' + (error.message || error))
                                            }
                                          }}
                                          style={{padding: '6px 8px', fontSize: '0.8rem', background: '#b91c1c', color: '#fff', borderRadius: 4}}
                                        >
                                          Delete
                                        </button>
                                      </div>
                                    </td>
                                  )}
                      </>
                    )
                  })()}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="pagination-controls">
          <button
            onClick={goToPrevious}
            disabled={currentPage === 1}
            className="pagination-btn"
          >
            Previous
          </button>
          <span className="pagination-info">
            Page {currentPage} of {totalPages}
          </span>
          <button
            onClick={goToNext}
            disabled={currentPage === totalPages}
            className="pagination-btn"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
