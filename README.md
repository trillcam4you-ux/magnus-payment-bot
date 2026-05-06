# Magnus Billing Payment Bot

Telegram bot for selling VoIP plans connected to Magnus Billing 7.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `.env`:
```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
MAGNUS_URL=http://172.235.137.54/mbilling
MAGNUS_API_KEY=your_api_key
MAGNUS_API_SECRET=your_api_secret
ADMIN_TELEGRAM_IDS=your_telegram_id
BTC_ADDRESS=your_bitcoin_address
```

3. Start the bot:
```bash
node bot.js
```

## Features

- Create new accounts
- Activate/extend existing accounts
- Plan selection with inline keyboards
- Bitcoin payment integration (manual for now)
- Automatic credential generation

## Plans

| Plan | Price | Duration |
|------|-------|----------|
| Daily | $5 | 1 day |
| 3 Days | $12 | 3 days |
| Weekly | $25 | 7 days |
| Biweekly | $45 | 14 days |
| Monthly | $80 | 30 days |

## Magnus Billing API

The bot uses the Magnus Billing REST API with HMAC-SHA512 authentication.

## Testing

Run API tests:
```bash
node test-api.js
```

## Status

✅ API Connection: Working
✅ Read Operations: Working  
✅ Create Users: Working
⚠️ Create SIP: Requires API key with SIP module permissions
⚠️ Telegram Bot: Waiting for token

## Next Steps

1. Add your Telegram bot token to `.env`
2. Test the bot by messaging it on Telegram
3. Configure Bitcoin payment address
4. Enable SIP module permissions in Magnus Billing admin panel (optional)
