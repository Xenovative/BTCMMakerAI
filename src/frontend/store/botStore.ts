import { create } from 'zustand';

export interface BotConfig {
  paperTrade: boolean;
  maxBuyPrice: number;
  profitTarget: number;
  stopLoss: number;
  maxPositionSize: number;
  allowCurrentMarketTrading: boolean;
  privateKey: string;
  funderAddress: string;
}

export interface Position {
  tokenId: string;
  outcome: 'Up' | 'Down';
  size: number;
  avgBuyPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
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
  totalTrades: number;
  winRate: number;
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
    profitTarget: 2,
    stopLoss: 5,
    maxPositionSize: 100,
    allowCurrentMarketTrading: true,
    privateKey: '',
    funderAddress: '',
  },
  status: {
    running: false,
    connected: false,
    paperTrade: true,
    totalPnl: 0,
    totalTrades: 0,
    winRate: 0,
  },
  positions: [],
  trades: [],
  market: null,
  aiAnalysis: {},
  llmAnalysis: {},
  ws: null,

  connect: () => {
    const ws = new WebSocket(`ws://${window.location.hostname}:3001/ws`);
    
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
            set({ status: { ...get().status, ...data } });
            break;
          case 'config':
            set({ config: { ...get().config, ...data } });
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
                }
              : null;
            console.log('[WS][market]', parsedMarket);
            set({ market: parsedMarket });
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
              }));
              console.log('[WS][positions]', parsedPositions);
              set({ positions: parsedPositions });
            }
            break;
          case 'trade':
            set({ trades: [data, ...get().trades].slice(0, 100) });
            break;
          case 'trades':
            set({ trades: data });
            break;
          case 'pnl':
            set({ status: { ...get().status, totalPnl: data.totalPnl, totalTrades: data.totalTrades, winRate: data.winRate } });
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
