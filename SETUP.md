# Bot Setup Checklist

## ✅ Completed

1. ✅ Magnus Billing API connection
2. ✅ Read operations (users, plans, SIP)
3. ✅ Create user accounts
4. ✅ Update user expiration
5. ✅ Delete test users

## ⏳ Need Your Input

### 1. Telegram Bot Token
- Go to @BotFather on Telegram
- Create a new bot or use existing
- Copy the token
- Update `.env` file with `TELEGRAM_BOT_TOKEN=your_token_here`

### 2. Bitcoin Payment Address (Optional)
- Add your BTC address to `.env`
- Currently set to manual payment verification

### 3. SIP Account Creation (Optional)
The API returns 403 when creating SIP accounts. To enable:
- Log into Magnus Billing admin panel
- Go to System → API Access
- Edit your API key permissions
- Enable "SIP" module write access

## 🚀 Start the Bot

```bash
cd magnus-payment-bot
node bot.js
```

## 📱 Using the Bot

1. Send `/start` to your bot
2. Choose "Create New Account" or "Activate Existing"
3. Select a plan
4. Reply "yes" to simulate payment
5. Receive credentials
