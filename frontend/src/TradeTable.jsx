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
  if (upper === 'LONG') return 'LONG';
  if (upper === 'SHORT') return 'SHORT';
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

export default function TradeTable({items, onRefresh, calculatePnL, formatCurrency, currentPrices, bitgetPositions, rawCount}){
  const [currentPage, setCurrentPage] = useState(1)

  // Calculate pagination
  const totalItems = items.length
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE)
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE
  const endIndex = startIndex + ITEMS_PER_PAGE
  const currentItems = items.slice(startIndex, endIndex)

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
        {typeof rawCount === 'number' && rawCount > totalItems && (
          <div style={{ marginLeft: 12, fontSize: 12 }} className="muted">Signals/received alerts omitted from table ({rawCount - totalItems})</div>
        )}
      </div>
      <div className="table-scroller" tabIndex={0} aria-label="Trade history">
        <table className="trades">
          <thead><tr><th>When</th><th>Symbol</th><th>Signal</th><th>Price</th><th>Size (USD)</th><th>PnL</th><th>Status</th></tr></thead>
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
                  <td className="muted" data-label="When">{fmtTime(it.created_at)}</td>
                  <td className="symbol-cell" data-label="Symbol">
                    <strong>{it.symbol}</strong>
                    <div className="muted id">{it.id?.slice(0,10)}</div>
                  </td>
                  <td data-label="Signal">
                    <span className={`signal-tag ${it.signal?.toUpperCase() === 'LONG' ? 'signal-long' : it.signal?.toUpperCase() === 'SHORT' ? 'signal-short' : ''}`}>
                      {getDisplaySignal(it.signal)}
                    </span>
                  </td>
                  <td data-label="Price">{it.price!=null? Number(it.price).toFixed(2):'-'}</td>
                  <td data-label="Size (USD)">{it.size_usd!=null? formatCurrency(it.size_usd):'-'}</td>
                  <td className={pnlClass} data-label="PnL">
                    <div>{showPnL ? pnlDisplay : '-'}</div>
                  </td>
                  <td className={getStatusClass(it.status)} data-label="Status">{(it.status||'').toLowerCase()}</td>
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
