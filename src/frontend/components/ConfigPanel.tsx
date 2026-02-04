import React, { useState, useEffect } from 'react';
import { Settings, Key, DollarSign, Hash, Eye, EyeOff, Wallet, Shield, AlertTriangle } from 'lucide-react';
import { useBotStore, BotConfig } from '../store/botStore';

export function ConfigPanel() {
  const { config, updateConfig, status } = useBotStore();
  const [localConfig, setLocalConfig] = useState<BotConfig>(config);
  const [showPrivateKey, setShowPrivateKey] = useState(false);

  useEffect(() => {
    setLocalConfig(config);
  }, [config]);

  const handleChange = (field: keyof BotConfig, value: string | number | boolean) => {
    setLocalConfig((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = () => {
    updateConfig(localConfig);
  };

  return (
    <div className="space-y-6">
      {/* Trading Mode */}
      <div className="cyber-card rounded-xl p-6">
        <div className="flex items-center gap-2 text-xl font-bold text-white mb-6">
          <Shield className="w-6 h-6 text-purple-400" />
          交易模式
        </div>

        <div className="flex items-center gap-6">
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className={`relative w-6 h-6 rounded-full border-2 transition-all ${
              localConfig.paperTrade 
                ? 'border-green-500 bg-green-500/20' 
                : 'border-gray-600 group-hover:border-gray-500'
            }`}>
              {localConfig.paperTrade && (
                <div className="absolute inset-1 bg-green-500 rounded-full" />
              )}
            </div>
            <input
              type="radio"
              name="tradeMode"
              checked={localConfig.paperTrade}
              onChange={() => handleChange('paperTrade', true)}
              className="sr-only"
              disabled={status.running}
            />
            <div>
              <span className="text-green-400 font-bold">📝 模擬交易</span>
              <p className="text-gray-500 text-xs">不使用真實資金</p>
            </div>
          </label>

          <label className="flex items-center gap-3 cursor-pointer group">
            <div className={`relative w-6 h-6 rounded-full border-2 transition-all ${
              !localConfig.paperTrade 
                ? 'border-red-500 bg-red-500/20' 
                : 'border-gray-600 group-hover:border-gray-500'
            }`}>
              {!localConfig.paperTrade && (
                <div className="absolute inset-1 bg-red-500 rounded-full" />
              )}
            </div>
            <input
              type="radio"
              name="tradeMode"
              checked={!localConfig.paperTrade}
              onChange={() => handleChange('paperTrade', false)}
              className="sr-only"
              disabled={status.running}
            />
            <div>
              <span className="text-red-400 font-bold">💰 真實交易</span>
              <p className="text-gray-500 text-xs">使用真實資金</p>
            </div>
          </label>
        </div>

        {!localConfig.paperTrade && (
          <div className="mt-4 p-4 bg-red-900/20 border border-red-500/30 rounded-lg flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="text-red-400 font-bold">⚠️ 真實交易模式</p>
              <p className="text-red-300/70">將使用真實資金進行交易。請確保你的錢包有足夠的 USDC。</p>
            </div>
          </div>
        )}
      </div>

      {/* Order Settings */}
      <div className="cyber-card rounded-xl p-6">
        <div className="flex items-center gap-2 text-xl font-bold text-white mb-6">
          <DollarSign className="w-6 h-6 text-cyan-400" />
          交易參數
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm text-gray-400 mb-2">最高買入價格 (¢)</label>
            <input
              type="number"
              step="1"
              min="1"
              max="99"
              value={localConfig.maxBuyPrice}
              onChange={(e) => handleChange('maxBuyPrice', parseInt(e.target.value) || 50)}
              className="w-full bg-gray-800 border border-purple-500/30 rounded-lg px-4 py-3 text-white font-mono focus:outline-none focus:border-purple-500 transition-colors"
              disabled={status.running}
            />
            <p className="text-xs text-gray-600 mt-1">只買入低於此價格的選項</p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">價格下限 (¢)</label>
            <input
              type="number"
              step="0.5"
              min="0.5"
              max="99"
              value={localConfig.priceFloor}
              onChange={(e) => handleChange('priceFloor', parseFloat(e.target.value) || 1)}
              className="w-full bg-gray-800 border border-green-500/30 rounded-lg px-4 py-3 text-white font-mono focus:outline-none focus:border-green-500 transition-colors"
              disabled={status.running}
            />
            <p className="text-xs text-gray-600 mt-1">低於此價不進場</p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">價格上限 (¢)</label>
            <input
              type="number"
              step="0.5"
              min="1"
              max="99.5"
              value={localConfig.priceCeiling}
              onChange={(e) => handleChange('priceCeiling', parseFloat(e.target.value) || 99)}
              className="w-full bg-gray-800 border border-red-500/30 rounded-lg px-4 py-3 text-white font-mono focus:outline-none focus:border-red-500 transition-colors"
              disabled={status.running}
            />
            <p className="text-xs text-gray-600 mt-1">高於此價不進場</p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">AI 最小倉位 (股)</label>
            <input
              type="number"
              step="1"
              min="1"
              value={localConfig.aiMinPositionSize ?? 1}
              onChange={(e) => handleChange('aiMinPositionSize', parseInt(e.target.value) || 1)}
              className="w-full bg-gray-800 border border-purple-500/30 rounded-lg px-4 py-3 text-white font-mono focus:outline-none focus:border-purple-500 transition-colors"
              disabled={status.running}
            />
            <p className="text-xs text-gray-600 mt-1">AI 推薦的最小下單股數</p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">Limit Sell 目標 (%)</label>
            <input
              type="number"
              step="0.1"
              min="0.1"
              max="50"
              value={(localConfig.profitTargetPct ?? 0) * 100}
              onChange={(e) => handleChange('profitTargetPct', (parseFloat(e.target.value) || 0) / 100)}
              className="w-full bg-gray-800 border border-cyan-500/30 rounded-lg px-4 py-3 text-white font-mono focus:outline-none focus:border-cyan-500 transition-colors"
              disabled={status.running}
            />
            <p className="text-xs text-gray-600 mt-1">買入後自動掛賣單，價格 = 買入價 * (1 + 目標%)</p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">止損點 (%)</label>
            <input
              type="number"
              step="0.1"
              min="0.5"
              max="50"
              value={(localConfig.stopLossPct ?? 0) * 100}
              onChange={(e) => handleChange('stopLossPct', (parseFloat(e.target.value) || 0) / 100)}
              className="w-full bg-gray-800 border border-red-500/30 rounded-lg px-4 py-3 text-white font-mono focus:outline-none focus:border-red-500 transition-colors"
              disabled={status.running}
            />
            <p className="text-xs text-gray-600 mt-1">虧損超過此百分比時自動賣出</p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">雙邊價格上限 (總和 %)</label>
            <input
              type="number"
              step="0.1"
              min="50"
              max="110"
              value={(localConfig.combinedPriceCap ?? 1) * 100}
              onChange={(e) => handleChange('combinedPriceCap', (parseFloat(e.target.value) || 0) / 100)}
              className="w-full bg-gray-800 border border-yellow-500/30 rounded-lg px-4 py-3 text-white font-mono focus:outline-none focus:border-yellow-500 transition-colors"
              disabled={status.running}
            />
            <p className="text-xs text-gray-600 mt-1">Only buy when Up+Down is below this percentage cap</p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2 flex items-center gap-1">
              <Hash className="w-4 h-4" />
              每筆交易股數
            </label>
            <input
              type="number"
              step="10"
              min="1"
              value={localConfig.maxPositionSize}
              onChange={(e) => handleChange('maxPositionSize', parseInt(e.target.value) || 100)}
              className="w-full bg-gray-800 border border-pink-500/30 rounded-lg px-4 py-3 text-white font-mono focus:outline-none focus:border-pink-500 transition-colors"
              disabled={status.running}
            />
            <p className="text-xs text-gray-600 mt-1">每次買入的股數</p>
          </div>
        </div>

        {/* Current Market Trading Toggle */}
        <div className="mt-6 p-4 bg-gray-800/50 rounded-lg border border-gray-700">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-white font-medium">允許盤中交易</span>
              <p className="text-xs text-gray-500 mt-1">開啟後可在當前市場進行低吸買入</p>
            </div>
            <div className="relative">
              <input
                type="checkbox"
                checked={localConfig.allowCurrentMarketTrading}
                onChange={(e) => handleChange('allowCurrentMarketTrading', e.target.checked)}
                className="sr-only"
                disabled={status.running}
              />
              <div className={`w-14 h-7 rounded-full transition-colors ${
                localConfig.allowCurrentMarketTrading ? 'bg-green-600' : 'bg-gray-600'
              }`}>
                <div className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full transition-transform ${
                  localConfig.allowCurrentMarketTrading ? 'translate-x-7' : 'translate-x-0'
                }`} />
              </div>
            </div>
          </label>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2 flex items-center gap-2">
              <Key className="w-4 h-4 text-yellow-400" />
              私鑰 (Private Key)
            </label>
            <div className="relative">
              <input
                type={showPrivateKey ? 'text' : 'password'}
                value={localConfig.privateKey}
                onChange={(e) => handleChange('privateKey', e.target.value)}
                className="w-full bg-gray-800 border border-yellow-500/30 rounded-lg px-4 py-3 pr-12 text-white font-mono focus:outline-none focus:border-yellow-500 transition-colors"
                placeholder="輸入你的錢包私鑰..."
                disabled={status.running}
              />
              <button
                type="button"
                onClick={() => setShowPrivateKey(!showPrivateKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors"
              >
                {showPrivateKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2 flex items-center gap-2">
              <Wallet className="w-4 h-4 text-purple-400" />
              Polymarket Proxy Wallet 地址
            </label>
            <input
              type="text"
              value={localConfig.funderAddress}
              onChange={(e) => handleChange('funderAddress', e.target.value)}
              className="w-full bg-gray-800 border border-purple-500/30 rounded-lg px-4 py-3 text-white font-mono focus:outline-none focus:border-purple-500 transition-colors"
              placeholder="0x..."
              disabled={status.running}
            />
            <p className="text-xs text-gray-600 mt-1">
              這是你在 Polymarket 的資金地址，不是你的 MetaMask 地址
            </p>
          </div>
        </div>

        <div className="mt-4 p-3 bg-yellow-900/20 border border-yellow-500/30 rounded-lg">
          <p className="text-yellow-400 text-xs flex items-center gap-2">
            <Shield className="w-4 h-4" />
            你的私鑰只會儲存在本地，不會上傳到任何伺服器
          </p>
        </div>
      </div>

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={status.running}
        className={`w-full py-4 rounded-xl font-bold text-lg transition-all duration-300 ${
          status.running
            ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
            : 'bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 text-white cyber-glow'
        }`}
      >
        {status.running ? '⏸️ 停止機器人後才能修改設定' : '💾 儲存設定'}
      </button>
    </div>
  );
}
