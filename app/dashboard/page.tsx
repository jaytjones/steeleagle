// ============================================================
// SteelEagle — Dashboard (placeholder)
// Scanner cards and positions monitor will be built here
// ============================================================

export default function Dashboard() {
  return (
    <main className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">🦅 SteelEagle</h1>
          <span className="text-gray-500 text-sm">
            {new Date().toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {['SPY', 'TLT', 'GLD'].map((symbol) => (
            <div
              key={symbol}
              className="bg-gray-900 border border-gray-800 rounded-xl p-6"
            >
              <div className="text-lg font-semibold">{symbol}</div>
              <div className="text-gray-500 text-sm mt-1">Scanner coming soon</div>
            </div>
          ))}
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <div className="text-lg font-semibold mb-2">Open Positions</div>
          <div className="text-gray-500 text-sm">Positions monitor coming soon</div>
        </div>
      </div>
    </main>
  )
}
