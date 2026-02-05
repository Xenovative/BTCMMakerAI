import { create } from 'zustand';

export interface BotConfig {
  paperTrade: boolean;
  maxBuyPrice: number;
  priceFloor: number;
  priceCeiling: number;
  profitTarget: number;
  profitTargetPct: number;
  stopLoss: number;
  stopLossPct: number;
  maxPositionSize: number;
  aiMinPositionSize: number;
  lossStreakCooldownMs: number;
  lossStreakThreshold: number;
  allowCurrentMarketTrading: boolean;
  combinedPriceCap: number;
  buyLeaderPrestart: boolean;
  privateKey: string;
  funderAddress: string;
  llmEnabled: boolean;
  llmProvider: string;
  openaiModel: string;
  openaiApiKey?: string | null;
  volcanoModel: string;
  volcanoBaseUrl: string;
  volcanoApiKey?: string | null;
  pollIntervalMs: number;
}

export interface Position {
  tokenId: string;
  outcome: 'Up' | 'Down';
  size: number;
  avgBuyPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  market?: string;
  returnPct?: number;
  returnUsd?: number;
}

export interface Trade {
  id: string;
  timestamp: number;
  market: string;
  outcome: 'Up' | 'Down';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  pnl?: number;
  pnlPercent?: number;
}

export interface MarketState {
  currentMarket: string | null;
  nextMarket: string | null;
  upPrice: number;
  downPrice: number;
  currentUpPrice: number;
  currentDownPrice: number;
  timeToStart: number;
  timeToEnd: number;
  btcSpot?: number;
}

export interface AIAnalysisBrief {
  shouldTrade: boolean;
  recommendedOutcome: 'Up' | 'Down' | null;
  confidence: number;
  recommendedSize: number;
  reasons?: string[];
  signals?: {
    technical?: number;
    orderBook?: number;
    sentiment?: number;
    timing?: number;
  };
}

export interface LLMAnalysisBrief {
  shouldTrade: boolean;
  recommendedOutcome: 'Up' | 'Down' | null;
  confidence: number;
  recommendedSize: number;
  reasoning: string;
  marketSummary: string;
}

export type AnalysisScope = 'next' | 'current';

export interface BotStatus {
  running: boolean;
  connected: boolean;
  paperTrade: boolean;
  totalPnl: number;
  totalPnlPct?: number;
  totalCost?: number;
  totalTrades: number;
  winRate: number;
  uptimeSeconds?: number;
  walletBalance?: number;
}

interface BotStore {
  config: BotConfig;
  status: BotStatus;
  positions: Position[];
  trades: Trade[];
  market: MarketState | null;
  aiAnalysis: Partial<Record<AnalysisScope, AIAnalysisBrief>>;
  llmAnalysis: Partial<Record<AnalysisScope, LLMAnalysisBrief>>;
  ws: WebSocket | null;
  
  connect: () => void;
  disconnect: () => void;
  updateConfig: (config: Partial<BotConfig>) => void;
  startBot: () => void;
  stopBot: () => void;
}

export const useBotStore = create<BotStore>((set, get) => ({
  config: {
    paperTrade: true,
    maxBuyPrice: 50,
    priceFloor: 1,
    priceCeiling: 99,
    profitTarget: 2,
    profitTargetPct: 0.05,
    stopLoss: 5,
    stopLossPct: 0.05,
    maxPositionSize: 100,
    aiMinPositionSize: 1,
    lossStreakCooldownMs: 120000,
    lossStreakThreshold: 3,
    allowCurrentMarketTrading: true,
    combinedPriceCap: 0.98,
    buyLeaderPrestart: false,
    privateKey: '',
    funderAddress: '',
    llmEnabled: true,
    llmProvider: 'openai',
    openaiModel: 'gpt-4o-mini',
    openaiApiKey: '',
    volcanoModel: 'ep-20250318191336-qz8fn',
    volcanoBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    volcanoApiKey: '',
    pollIntervalMs: 10000,
  },
  status: {
    running: false,
    connected: false,
    paperTrade: true,
    totalPnl: 0,
    totalPnlPct: 0,
    totalCost: 0,
    totalTrades: 0,
    winRate: 0,
    uptimeSeconds: 0,
  },
  positions: [],
  trades: [],
  market: null,
  aiAnalysis: {},
  llmAnalysis: {},
  ws: null,

  connect: () => {
    const envWsUrl = (import.meta as any).env?.VITE_WS_URL as string | undefined;
    const host = (import.meta as any).env?.VITE_API_HOST || window.location.hostname;
    const port = (import.meta as any).env?.VITE_API_PORT || window.location.port || '3001';
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = envWsUrl || `${protocol}://${host}:${port}/ws`;
    const ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log('[WS] Connected');
      set({ ws, status: { ...get().status, connected: true } });
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      set({ ws: null, status: { ...get().status, connected: false } });
      // Reconnect after 3 seconds
      setTimeout(() => get().connect(), 3000);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        const { type, data } = message;

        switch (type) {
          case 'status':
            set({ status: { ...get().status, ...data, uptimeSeconds: data?.uptimeSeconds != null ? Number(data.uptimeSeconds) : get().status.uptimeSeconds } });
            break;
          case 'config':
            set({ config: {
              ...get().config,
              ...data,
              aiMinPositionSize: data.aiMinPositionSize ?? get().config.aiMinPositionSize,
              profitTargetPct: data.profitTargetPct ?? get().config.profitTargetPct,
              stopLossPct: data.stopLossPct ?? get().config.stopLossPct,
              combinedPriceCap: data.combinedPriceCap ?? get().config.combinedPriceCap,
              buyLeaderPrestart: data.buyLeaderPrestart ?? get().config.buyLeaderPrestart,
              llmEnabled: data.llmEnabled ?? get().config.llmEnabled,
              llmProvider: data.llmProvider ?? get().config.llmProvider,
              openaiModel: data.openaiModel ?? get().config.openaiModel,
              openaiApiKey: data.openaiApiKey ?? get().config.openaiApiKey,
              volcanoModel: data.volcanoModel ?? get().config.volcanoModel,
              volcanoBaseUrl: data.volcanoBaseUrl ?? get().config.volcanoBaseUrl,
              volcanoApiKey: data.volcanoApiKey ?? get().config.volcanoApiKey,
              pollIntervalMs: data.pollIntervalMs ?? get().config.pollIntervalMs,
            } });
            break;
          case 'market':
            // Ensure numeric prices and log for debugging
            const parsedMarket = data
              ? {
                  currentMarket: data.currentMarket ?? null,
                  nextMarket: data.nextMarket ?? null,
                  upPrice: Number(data.upPrice),
                  downPrice: Number(data.downPrice),
                  currentUpPrice: Number(data.currentUpPrice),
                  currentDownPrice: Number(data.currentDownPrice),
                  timeToStart: Number(data.timeToStart),
                  timeToEnd: Number(data.timeToEnd),
                  btcSpot: data.btcSpot != null ? Number(data.btcSpot) : undefined,
                }
              : null;
            console.log('[WS][market]', parsedMarket);
            set({ market: parsedMarket });
            if (data?.uptimeSeconds != null) {
              set({ status: { ...get().status, uptimeSeconds: Number(data.uptimeSeconds) } });
            }
            break;
          case 'positions':
            if (Array.isArray(data)) {
              const parsedPositions = data.map((p: any) => ({
                tokenId: p.tokenId,
                outcome: p.outcome,
                size: Number(p.size) || 0,
                avgBuyPrice: Number(p.avgBuyPrice) || 0,
                currentPrice: Number(p.currentPrice) || 0,
                unrealizedPnl: Number(p.unrealizedPnl) || 0,
                market: p.market || undefined,
                returnPct: p.returnPct != null ? Number(p.returnPct) : undefined,
                returnUsd: p.returnUsd != null ? Number(p.returnUsd) : undefined,
              }));
              console.log('[WS][positions]', parsedPositions);
              set({ positions: parsedPositions });
            }
            break;
          case 'trade':
            set({ trades: [
              {
                ...data,
                price: Number(data.price) || 0,
                size: Number(data.size) || 0,
                pnl: data.pnl != null ? Number(data.pnl) : undefined,
                timestamp: data.timestamp != null ? Number(data.timestamp) : Date.now(),
              },
              ...get().trades,
            ].slice(0, 200) });
            break;
          case 'trades':
            if (Array.isArray(data)) {
              const parsedTrades = data.map((t: any) => ({
                ...t,
                price: Number(t.price) || 0,
                size: Number(t.size) || 0,
                pnl: t.pnl != null ? Number(t.pnl) : undefined,
                timestamp: t.timestamp != null ? Number(t.timestamp) : Date.now(),
              }));
              set({ trades: parsedTrades });
            }
            break;
          case 'pnl':
            set({ status: { 
              ...get().status,
              totalPnl: Number(data.totalPnl) || 0,
              totalPnlPct: data.totalPnlPct != null ? Number(data.totalPnlPct) : undefined,
              totalCost: data.totalCost != null ? Number(data.totalCost) : undefined,
              totalTrades: data.totalTrades || 0,
              winRate: data.winRate || 0,
              walletBalance: data.walletBalance != null ? Number(data.walletBalance) : get().status.walletBalance,
            } });
            break;
          case 'ai_analysis':
            set({ aiAnalysis: { ...get().aiAnalysis, [data.scope || 'next']: data } });
            break;
          case 'llm_analysis':
            set({ llmAnalysis: { ...get().llmAnalysis, [data.scope || 'next']: data } });
            break;
        }
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    };
  },

  disconnect: () => {
    const { ws } = get();
    if (ws) {
      ws.close();
      set({ ws: null });
    }
  },

  updateConfig: (newConfig) => {
    const { ws, config } = get();
    const updated = { ...config, ...newConfig };
    set({ config: updated });
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'config', data: updated }));
    }
  },

  startBot: () => {
    const { ws } = get();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'start' }));
    }
  },

  stopBot: () => {
    const { ws } = get();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
    }
  },
}));
