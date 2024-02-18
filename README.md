# Backpack Trade
### Create `.env` in root folder
```
API_KEY = "<BACKPACK_API_KEY>"
API_SECRET = "<BACKPACK_API_SECRET>"
```
### Run Script
```bash
npm run trade
```

### To add more token trade, please update `src/config.ts`
```
export const TRADE_TOKEN = ["JUP", "BONK"]
export const percent_trades = [0.5, 0.6, 0.7, 0.8]
export const DELAY_MIN = 10000
export const DELAY_MAX = 15000
```