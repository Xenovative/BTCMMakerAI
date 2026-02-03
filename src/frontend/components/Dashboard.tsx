import React from 'react';
import { TrendingUp, TrendingDown, Clock, DollarSign, Activity, Target, Zap, Play, Square, Brain, Sparkles } from 'lucide-react';
import { useBotStore } from '../store/botStore';

export function Dashboard() {
  const { status, market, positions, aiAnalysis, llmAnalysis, trades, config, startBot, stopBot } = useBotStore();

  const formatDuration = (secondsInput: number) => {
    const seconds = Math.max(0, Math.floor(secondsInput));
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const hh = hrs.toString().padStart(2, '0');
    const mm = mins.toString().padStart(2, '0');
    const ss = secs.toString().padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };

  const renderConfidenceBar = (value: number) => (
    <div className="w-full bg-gray-700 rounded-full h-2 mt-2">
      <div
        className="bg-gradient-to-r from-cyan-500 to-purple-500 h-2 rounded-full transition-all duration-500"
        style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }}
      />
    </div>
  );

  const pnlSeries = React.useMemo(() => {
    const chronological = [...trades].reverse();
    let cum = 0;
    const points = chronological.map((t, idx) => {
      const delta = Number(t.pnl ?? 0);
      cum += delta;
      return { x: idx, y: cum / 100 }; // USDC
    });
    if (points.length === 0) return [];
    // ensure baseline at zero for nicer chart
    return [{ x: -1, y: 0 }, ...points];
  }, [trades]);

  const renderPnlChart = () => {
    if (pnlSeries.length === 0) {
      return <div className="text-gray-500 text-sm">尚無交易記錄</div>;
    }
    const width = 360;
    const height = 180;
    const xs = pnlSeries.map(p => p.x);
    const ys = pnlSeries.map(p => p.y);
    const minY = Math.min(...ys, 0);
    const maxY = Math.max(...ys, 0.01);
    const spanY = maxY - minY || 1;
    const spanX = (Math.max(...xs) - Math.min(...xs)) || 1;
    const minX = Math.min(...xs);
    const scaleX = (x: number) => ((x - minX) / spanX) * width;
    const scaleY = (y: number) => height - ((y - minY) / spanY) * height;
    const path = pnlSeries
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(p.x).toFixed(2)} ${scaleY(p.y).toFixed(2)}`)
      .join(' ');
    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48">
        <defs>
          <linearGradient id="pnlGradient" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={path} fill="none" stroke="#34d399" strokeWidth="2.5" />
        <path
          d={`${path} L ${scaleX(pnlSeries[pnlSeries.length - 1].x).toFixed(2)} ${height} L ${scaleX(pnlSeries[0].x).toFixed(2)} ${height} Z`}
          fill="url(#pnlGradient)"
          opacity={0.3}
        />
        <line x1="0" x2={width} y1={scaleY(0)} y2={scaleY(0)} stroke="#4b5563" strokeDasharray="4 4" />
      </svg>
    );
  };

  return (
    <div className="space-y-6">
      {/* Control Panel */}
      <div className="cyber-card rounded-xl p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-white mb-1">交易控制</h2>
            <p className="text-gray-500 text-sm">啟動或停止自動交易機器人</p>
          </div>
          <button
            onClick={() => status.running ? stopBot() : startBot()}
            className={`flex items-center gap-3 px-8 py-4 rounded-xl font-bold text-lg transition-all duration-300 ${
              status.running
                ? 'bg-red-600 hover:bg-red-700 text-white cyber-glow-pink'
                : 'bg-gradient-to-r from-cyan-500 to-purple-600 hover:from-cyan-400 hover:to-purple-500 text-white cyber-glow-cyan'
            }`}
          >
            {status.running ? (
              <>
                <Square className="w-6 h-6" />
                停止交易
              </>
            ) : (
              <>
                <Play className="w-6 h-6" />
                啟動交易
              </>
            )}
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total PnL */}
        <div className="cyber-card rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-gray-500 text-sm">總盈虧</span>
            <DollarSign className={`w-5 h-5 ${status.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`} />
          </div>
          <div className={`text-3xl font-bold ${status.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {status.totalPnl >= 0 ? '+' : ''}${(status.totalPnl / 100).toFixed(4)} USDC
          </div>
          <div className="text-gray-600 text-xs mt-1">
            {(status.totalPnl >= 0 ? '+' : '') + status.totalPnl.toFixed(2)}¢
          </div>
        </div>

        {/* Total Trades */}
        <div className="cyber-card rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-gray-500 text-sm">總交易數</span>
            <Activity className="w-5 h-5 text-purple-400" />
          </div>
          <div className="text-3xl font-bold text-white">
            {status.totalTrades}
          </div>
          <div className="text-gray-600 text-xs mt-1">
            筆交易完成
          </div>
        </div>

        {/* Win Rate */}
        <div className="cyber-card rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-gray-500 text-sm">勝率</span>
            <Target className="w-5 h-5 text-cyan-400" />
          </div>
          <div className="text-3xl font-bold text-cyan-400">
            {status.winRate.toFixed(1)}%
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2 mt-2">
            <div 
              className="bg-gradient-to-r from-cyan-500 to-purple-500 h-2 rounded-full transition-all duration-500"
              style={{ width: `${Math.min(status.winRate, 100)}%` }}
            />
          </div>
        </div>

        {/* Bot Status */}
        <div className="cyber-card rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-gray-500 text-sm">機器人狀態</span>
            <Zap className={`w-5 h-5 ${status.running ? 'text-yellow-400 animate-pulse' : 'text-gray-600'}`} />
          </div>
          <div className={`text-3xl font-bold ${status.running ? 'text-yellow-400' : 'text-gray-500'}`}>
            {status.running ? 'ACTIVE' : 'IDLE'}
          </div>
          <div className="text-gray-600 text-xs mt-1">
            {status.paperTrade ? '模擬交易模式' : '真實交易模式'}
          </div>
          <div className="text-gray-400 text-xs mt-2 flex items-center gap-2">
            <Clock className="w-4 h-4" /> 運行時間 {formatDuration(status.uptimeSeconds || 0)}
          </div>
        </div>
      </div>

      {/* Market Info */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Total PnL Chart */}
        <div className="cyber-card rounded-xl p-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-green-400" />
              <h3 className="text-lg font-bold text-white">累計盈虧走勢</h3>
            </div>
            <div className={`text-sm font-mono ${status.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {status.totalPnl >= 0 ? '+' : ''}{(status.totalPnl / 100).toFixed(4)} USDC
            </div>
          </div>
          {renderPnlChart()}
        </div>

        {/* Current Market */}
        <div className="cyber-card rounded-xl p-6">
          <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
            <Clock className="w-5 h-5 text-purple-400" />
            市場狀態
          </h3>
          
          {market ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-gray-800/50 rounded-lg">
                <div>
                  <div className="text-gray-500 text-xs mb-1">當前市場</div>
                  <div className="text-white font-medium">{market.currentMarket || '等待中...'}</div>
                </div>
                <div className="text-right">
                  <div className="text-gray-500 text-xs mb-1">距離結束</div>
                  <div className="text-cyan-400 font-mono text-xl">{formatDuration((market.timeToEnd || 0) / 1000)}</div>
                </div>
              </div>
              
              <div className="flex items-center justify-between p-4 bg-purple-900/20 rounded-lg border border-purple-500/30">
                <div>
                  <div className="text-gray-500 text-xs mb-1">下一市場</div>
                  <div className="text-white font-medium">{market.nextMarket || '等待中...'}</div>
                </div>
                <div className="text-right">
                  <div className="text-gray-500 text-xs mb-1">距離開始</div>
                  <div className="text-purple-400 font-mono text-xl">{formatDuration((market.timeToStart || 0) / 1000)}</div>
                </div>
              </div>

              {/* BTC Spot */}
              {market.btcSpot != null && (
                <div className="p-4 bg-gray-800/60 rounded-lg border border-yellow-400/40 flex items-center justify-between mt-4">
                  <div className="flex items-center gap-2">
                    <span className="text-yellow-300 font-bold">BTC 即時價</span>
                  </div>
                  <div className="text-2xl font-bold text-yellow-300 font-mono">${market.btcSpot.toFixed(2)}</div>
                </div>
              )}

              {/* Prices */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                <div className="p-4 bg-green-900/20 rounded-lg border border-green-500/30">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="w-5 h-5 text-green-400" />
                      <span className="text-green-400 font-bold">當前 UP</span>
                    </div>
                    <span className="text-xs text-gray-400">{market.currentMarket || 'N/A'}</span>
                  </div>
                  <div className="text-3xl font-bold text-white">{(market.currentUpPrice ?? market.upPrice).toFixed(1)}¢</div>
                </div>
                <div className="p-4 bg-red-900/20 rounded-lg border border-red-500/30">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <TrendingDown className="w-5 h-5 text-red-400" />
                      <span className="text-red-400 font-bold">當前 DOWN</span>
                    </div>
                    <span className="text-xs text-gray-400">{market.currentMarket || 'N/A'}</span>
                  </div>
                  <div className="text-3xl font-bold text-white">{(market.currentDownPrice ?? market.downPrice).toFixed(1)}¢</div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                <div className="p-4 bg-green-900/10 rounded-lg border border-green-500/20">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-green-300" />
                      <span className="text-green-300 font-semibold">下一 UP</span>
                    </div>
                    <span className="text-xs text-gray-400">{market.nextMarket || 'N/A'}</span>
                  </div>
                  <div className="text-2xl font-semibold text-white">{market.upPrice.toFixed(1)}¢</div>
                </div>
                <div className="p-4 bg-red-900/10 rounded-lg border border-red-500/20">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <TrendingDown className="w-4 h-4 text-red-300" />
                      <span className="text-red-300 font-semibold">下一 DOWN</span>
                    </div>
                    <span className="text-xs text-gray-400">{market.nextMarket || 'N/A'}</span>
                  </div>
                  <div className="text-2xl font-semibold text-white">{market.downPrice.toFixed(1)}¢</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <Clock className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>等待市場數據...</p>
            </div>
          )}
        </div>

        {/* Current Positions */}
        <div className="cyber-card rounded-xl p-6">
          <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
            <Activity className="w-5 h-5 text-cyan-400" />
            當前持倉
          </h3>
          
          {positions.filter((p) => p.size >= 0.1).length > 0 ? (
            <div className="space-y-3">
              {positions
                .filter((p) => p.size >= 0.1)
                .map((pos, idx) => (
                <div key={idx} className="p-4 bg-gray-800/50 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {pos.outcome === 'Up' ? (
                        <TrendingUp className="w-5 h-5 text-green-400" />
                      ) : (
                        <TrendingDown className="w-5 h-5 text-red-400" />
                      )}
                      <span className={`font-bold ${pos.outcome === 'Up' ? 'text-green-400' : 'text-red-400'}`}>
                        {pos.outcome}
                      </span>
                    </div>
                    <span className="text-white font-mono">{pos.size} 股</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div>
                      <div className="text-gray-500 text-xs">買入價</div>
                      <div className="text-white">{pos.avgBuyPrice.toFixed(1)}¢</div>
                    </div>
                    <div>
                      <div className="text-gray-500 text-xs">現價</div>
                      <div className="text-white">{pos.currentPrice.toFixed(1)}¢</div>
                    </div>
                    <div>
                      <div className="text-gray-500 text-xs">未實現盈虧</div>
                      <div className={pos.unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                        {pos.unrealizedPnl >= 0 ? '+' : ''}{pos.unrealizedPnl.toFixed(2)}¢
                        <span className="ml-2 text-xs text-gray-400">
                          ({pos.avgBuyPrice > 0 ? (((pos.currentPrice - pos.avgBuyPrice) / pos.avgBuyPrice) * 100).toFixed(1) + '%' : '—'})
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <Activity className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>目前沒有持倉</p>
            </div>
          )}
        </div>
      </div>

      {/* AI / LLM Analysis */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LLM Analysis */}
        <div className="cyber-card rounded-xl p-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Brain className="w-5 h-5 text-purple-300" />
              <h3 className="text-lg font-bold text-white">LLM 分析</h3>
            </div>
            <div className="flex gap-2 text-xs text-gray-400">
              <span className="px-2 py-1 rounded-full bg-gray-800">當前</span>
              <span className="px-2 py-1 rounded-full bg-gray-800">下一</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(['current', 'next'] as const).map(scope => {
              const la = llmAnalysis[scope];
              return (
                <div key={scope} className="space-y-3 p-3 rounded-lg bg-gray-800/50 border border-gray-700">
                  <div className="flex items-center justify-between">
                    <div className="text-gray-400 text-sm">{scope === 'current' ? '當前市場' : '下一市場'}</div>
                    <span className={`text-xs px-2 py-1 rounded-full ${la?.shouldTrade ? 'bg-green-600/40 text-green-200' : 'bg-gray-700 text-gray-300'}`}>
                      {la?.shouldTrade ? '建議交易' : '觀望'}
                    </span>
                  </div>
                  {la ? (
                    <>
                      <div className="flex items-center justify-between">
                        <div className="text-gray-400 text-sm">方向</div>
                        <div className="flex items-center gap-2 text-white font-semibold">
                          {la.recommendedOutcome === 'Up' ? <TrendingUp className="w-4 h-4 text-green-400" /> : <TrendingDown className="w-4 h-4 text-red-400" />}
                          <span className={la.recommendedOutcome === 'Up' ? 'text-green-400' : 'text-red-400'}>
                            {la.recommendedOutcome || 'N/A'}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="text-gray-400 text-sm">信心</div>
                        <div className="text-white font-semibold">{(la?.confidence ?? 0).toFixed(0)}%</div>
                      </div>
                      {renderConfidenceBar(la?.confidence ?? 0)}
                      <div className="flex items-center justify-between">
                        <div className="text-gray-400 text-sm">建議倉位</div>
                        <div className="text-white font-semibold">{la?.recommendedSize ?? 0} 股</div>
                      </div>
                      <div className="text-gray-300 text-sm bg-gray-800/50 p-2 rounded border border-gray-700 min-h-[56px]">
                        <div className="text-xs text-gray-500 mb-1">摘要</div>
                        <div>{la?.marketSummary || 'N/A'}</div>
                      </div>
                      <div className="text-gray-300 text-sm bg-purple-900/20 p-2 rounded border border-purple-500/30 min-h-[56px]">
                        <div className="text-xs text-purple-200 mb-1">推論</div>
                        <div>{la?.reasoning || 'N/A'}</div>
                      </div>
                    </>
                  ) : (
                    <div className="text-gray-500 text-sm flex items-center gap-2">
                      <Sparkles className="w-4 h-4" /> 等待 {scope === 'current' ? '當前' : '下一'} LLM 分析...
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Rule-based AI Analysis */}
        <div className="cyber-card rounded-xl p-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-cyan-300" />
              <h3 className="text-lg font-bold text-white">規則式 AI 分析</h3>
            </div>
            <div className="flex gap-2 text-xs text-gray-400">
              <span className="px-2 py-1 rounded-full bg-gray-800">當前</span>
              <span className="px-2 py-1 rounded-full bg-gray-800">下一</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(['current', 'next'] as const).map(scope => {
              const aa = aiAnalysis[scope];
              return (
                <div key={scope} className="space-y-3 p-3 rounded-lg bg-gray-800/50 border border-gray-700">
                  <div className="flex items-center justify-between">
                    <div className="text-gray-400 text-sm">{scope === 'current' ? '當前市場' : '下一市場'}</div>
                    <span className={`text-xs px-2 py-1 rounded-full ${aa?.shouldTrade ? 'bg-green-600/40 text-green-200' : 'bg-gray-700 text-gray-300'}`}>
                      {aa?.shouldTrade ? '建議交易' : '觀望'}
                    </span>
                  </div>
                  {aa ? (
                    <>
                      <div className="flex items-center justify-between">
                        <div className="text-gray-400 text-sm">方向</div>
                        <div className="flex items-center gap-2 text-white font-semibold">
                          {aa.recommendedOutcome === 'Up' ? <TrendingUp className="w-4 h-4 text-green-400" /> : <TrendingDown className="w-4 h-4 text-red-400" />}
                          <span className={aa.recommendedOutcome === 'Up' ? 'text-green-400' : 'text-red-400'}>
                            {aa.recommendedOutcome || 'N/A'}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="text-gray-400 text-sm">信心</div>
                        <div className="text-white font-semibold">{(aa?.confidence ?? 0).toFixed(0)}%</div>
                      </div>
                      {renderConfidenceBar(aa?.confidence ?? 0)}
                      <div className="flex items-center justify-between">
                        <div className="text-gray-400 text-sm">建議倉位</div>
                        <div className="text-white font-semibold">{aa?.recommendedSize ?? 0} 股</div>
                      </div>
                      {aa.reasons && aa.reasons.length > 0 && (
                        <div className="text-gray-300 text-sm bg-gray-800/50 p-3 rounded-lg border border-gray-700">
                          <div className="text-xs text-gray-500 mb-1">理由</div>
                          <ul className="list-disc list-inside space-y-1">
                            {aa.reasons.slice(0, 4).map((r: string, i: number) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-gray-500 text-sm flex items-center gap-2">
                      <Zap className="w-4 h-4" /> 等待 {scope === 'current' ? '當前' : '下一'} AI 分析...
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Bot Config Snapshot */}
      <div className="cyber-card rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="w-5 h-5 text-cyan-400" />
          <h3 className="text-lg font-bold text-white">當前交易設定</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 text-sm">
          <div className="p-3 bg-gray-800/50 rounded-lg border border-gray-700">
            <div className="text-gray-500 text-xs">最高買入</div>
            <div className="text-white font-mono text-lg">{config.maxBuyPrice.toFixed(1)}¢</div>
          </div>
          <div className="p-3 bg-gray-800/50 rounded-lg border border-gray-700">
            <div className="text-gray-500 text-xs">價格下限</div>
            <div className="text-green-400 font-mono text-lg">{config.priceFloor.toFixed(1)}¢</div>
          </div>
          <div className="p-3 bg-gray-800/50 rounded-lg border border-gray-700">
            <div className="text-gray-500 text-xs">價格上限</div>
            <div className="text-red-400 font-mono text-lg">{config.priceCeiling.toFixed(1)}¢</div>
          </div>
          <div className="p-3 bg-gray-800/50 rounded-lg border border-gray-700">
            <div className="text-gray-500 text-xs">Limit Sell 差距</div>
            <div className="text-white font-mono text-lg">+{config.profitTarget.toFixed(1)}¢</div>
          </div>
          <div className="p-3 bg-gray-800/50 rounded-lg border border-gray-700">
            <div className="text-gray-500 text-xs">止損</div>
            <div className="text-white font-mono text-lg">{config.stopLoss.toFixed(1)}¢</div>
          </div>
          <div className="p-3 bg-gray-800/50 rounded-lg border border-gray-700">
            <div className="text-gray-500 text-xs">每筆股數</div>
            <div className="text-white font-mono text-lg">{config.maxPositionSize}</div>
          </div>
          <div className="p-3 bg-gray-800/50 rounded-lg border border-gray-700 col-span-2 md:col-span-1">
            <div className="text-gray-500 text-xs">允許盤中</div>
            <div className={`text-sm font-bold ${config.allowCurrentMarketTrading ? 'text-green-400' : 'text-gray-400'}`}>
              {config.allowCurrentMarketTrading ? '開啟' : '關閉'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
