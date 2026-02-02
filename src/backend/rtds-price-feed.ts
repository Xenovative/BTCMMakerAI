import WebSocket from 'ws';
import { config } from '../config.js';

/**
 * RTDS (Real-Time Data Service) BTC spot price feed.
 * Defaults to Binance BTCUSDT trade stream if RTDS url is not provided.
 */
export class RTDSPriceFeed {
  private ws: WebSocket | null = null;
  private latestPrice: number | null = null;
  private lastUpdate = 0;

  connect(): void {
    if (this.ws) return;
    const url = config.RTDS_WS_URL || 'wss://stream.binance.com:9443/ws/btcusdt@trade';
    console.log('[RTDS] Connecting to', url);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[RTDS] Connected');
      if (config.RTDS_SUBSCRIBE_MESSAGE) {
        try {
          this.ws?.send(config.RTDS_SUBSCRIBE_MESSAGE);
          console.log('[RTDS] Subscription message sent');
        } catch (err) {
          console.warn('[RTDS] Failed to send subscribe payload', err);
        }
      }
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        // ignore malformed
      }
    });

    this.ws.on('close', () => {
      console.warn('[RTDS] Disconnected');
      this.ws = null;
    });

    this.ws.on('error', (err) => {
      console.warn('[RTDS] Error', err);
    });
  }

  getLatestPrice(): number | null {
    return this.latestPrice;
  }

  private handleMessage(msg: any): void {
    // Direct price fields (Binance style)
    const priceCandidate = msg?.price ?? msg?.p ?? msg?.lastPrice ?? msg?.last ?? msg?.data?.price ?? msg?.data?.p;
    let priceNum = Number(priceCandidate);

    // Chainlink Streams style: price object with bid/ask/mid
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      const bid = msg?.price?.bid ?? msg?.payload?.price?.bid ?? msg?.data?.price?.bid ?? msg?.bid;
      const ask = msg?.price?.ask ?? msg?.payload?.price?.ask ?? msg?.data?.price?.ask ?? msg?.ask;
      const mid = msg?.price?.mid ?? msg?.payload?.price?.mid ?? msg?.data?.price?.mid;

      if (mid != null) {
        priceNum = Number(mid);
      } else if (bid != null && ask != null) {
        const bidNum = Number(bid);
        const askNum = Number(ask);
        if (Number.isFinite(bidNum) && Number.isFinite(askNum) && askNum > 0) {
          priceNum = (bidNum + askNum) / 2;
        }
      }
    }

    if (!Number.isFinite(priceNum) || priceNum <= 0) return;

    this.latestPrice = priceNum;
    this.lastUpdate = Date.now();
  }
}

export const rtdsPriceFeed = new RTDSPriceFeed();
