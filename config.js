import 'dotenv/config';

// ──────────────────────────────────────────────────────────────────────────
// Your receiving addresses (from the mini app). DOUBLE-CHECK THESE.
// EVM address is used for BSC + Arbitrum. TRON address for TRC20.
// ──────────────────────────────────────────────────────────────────────────
export const ADDR_EVM  = (process.env.EVM_ADDRESS  || '0xd6207b9eeaa559699dcf62272ed416881bba8a27').trim();
export const ADDR_TRON = (process.env.TRON_ADDRESS || 'TZELSNUrT1vkQJcWYW8vKj8r53HrQ4cFaZ').trim();

export const BOT_TOKEN   = process.env.BOT_TOKEN;          // from @BotFather
export const WEBAPP_URL  = process.env.WEBAPP_URL || '';   // https URL where the mini app html is hosted

// Admin panel: access requires BOTH the verified Telegram ID and the password (env only).
export const ADMIN_ID = Number(process.env.ADMIN_ID || 1437839289);
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // set this in Railway, never in code
export const PORT        = process.env.PORT || 3000;
export const POLL_MS     = Number(process.env.POLL_MS || 30000);   // how often to scan the chains
export const DEPOSIT_TTL_MIN = Number(process.env.DEPOSIT_TTL_MIN || 60); // pending deposit lifetime

// Prices: review costs (server is the source of truth, not the client)
export const REVIEW_STARS  = 80;
export const REVIEW_USD     = 1;
export const OVERVIEW_STARS = 40;
export const OVERVIEW_USD    = 0.5;

// ──────────────────────────────────────────────────────────────────────────
// Networks + token contracts (mainnet). decimals matter for amount matching.
// type: 'evm-token' | 'evm-native' | 'tron-trc20'
// ──────────────────────────────────────────────────────────────────────────
// Etherscan API V2: ONE key for all EVM chains, selected via `chainid`.
// https://api.etherscan.io/v2/api?chainid=<id>&...&apikey=ETHERSCAN_KEY
export const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';

export const NETWORKS = {
  bsc: {
    label: 'BSC (BEP20)',
    scanner: ETHERSCAN_V2,
    chainId: 56,
    apiKeyEnv: 'ETHERSCAN_KEY',
    address: ADDR_EVM,
    tokens: {
      USDT: { type: 'evm-token', contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
      USDC: { type: 'evm-token', contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
      ETH:  { type: 'evm-token', contract: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18 } // pegged ETH on BSC
    }
  },
  arbitrum: {
    label: 'Arbitrum',
    scanner: ETHERSCAN_V2,
    chainId: 42161,
    apiKeyEnv: 'ETHERSCAN_KEY',
    address: ADDR_EVM,
    tokens: {
      USDT: { type: 'evm-token',  contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
      USDC: { type: 'evm-token',  contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
      ETH:  { type: 'evm-native', decimals: 18 } // native ETH on Arbitrum
    }
  },
  tron: {
    label: 'TRC20',
    scanner: 'https://api.trongrid.io',
    apiKeyEnv: 'TRONGRID_KEY', // optional, raises rate limit
    address: ADDR_TRON,
    tokens: {
      USDT: { type: 'tron-trc20', contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 }
    }
  }
};

// which (coin -> [networks]) the app offers
export const COIN_NETWORKS = {
  USDT: ['tron', 'bsc', 'arbitrum'],
  USDC: ['bsc', 'arbitrum'],
  ETH:  ['arbitrum', 'bsc']
  // BTC intentionally omitted: no BTC address provided. Add a BTC watcher separately if needed.
};

export function apiKey(net) { return process.env[NETWORKS[net].apiKeyEnv] || ''; }
