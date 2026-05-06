require('dotenv').config({ path: __dirname + '/.env' });
const { MagnusBillingAPI } = require('./magnus-api');

const MAGNUS_URL = process.env.MAGNUS_URL;
const API_KEY = process.env.MAGNUS_API_KEY;
const API_SECRET = process.env.MAGNUS_API_SECRET;

async function test() {
    if (!MAGNUS_URL || !API_KEY || !API_SECRET) {
        console.error('Missing MAGNUS_URL, MAGNUS_API_KEY, or MAGNUS_API_SECRET in .env');
        process.exit(1);
    }

    const api = new MagnusBillingAPI(API_KEY, API_SECRET, MAGNUS_URL);
    const username = 'bot' + Date.now().toString().slice(-6);
    const password = 'TestPass123';
    let userId;

    console.log('Testing Magnus API against', MAGNUS_URL, '\n');

    try {
        console.log('1. Creating user...');
        const userResult = await api.create('user', {
            username,
            password,
            id_group: 3,
            id_plan: 1,
            credit: 0,
            active: 1,
            callingcard_pin: Math.floor(Math.random() * 1000000).toString().padStart(6, '0'),
            callingcard_number: Math.floor(Math.random() * 10000000000).toString().padStart(10, '0'),
            expirationdate: '2026-12-31',
            enableexpire: 1,
            expiredays: 30
        });

        console.log('   User created:', userResult.success ? 'yes' : 'no', userResult.success ? '' : JSON.stringify(userResult.errors));
        userId = userResult.rows?.[0]?.id;
        console.log('   User ID:', userId);

        console.log('\n2. Creating SIP (optional — needs API SIP write permission)...');
        try {
            const sipResult = await api.create('sip', {
                id_user: userId,
                name: username,
                username: username,
                secret: password,
                host: 'dynamic',
                context: 'billing',
                allow: 'g729,ulaw,alaw',
                dtmfmode: 'RFC2833',
                nat: 'yes',
                type: 'friend',
                qualify: 'yes'
            });
            if (sipResult.success) {
                console.log('   SIP created: yes, id', sipResult.rows?.[0]?.id);
            } else {
                console.log('   SIP skipped:', JSON.stringify(sipResult.errors || sipResult));
            }
        } catch (e) {
            console.log('   SIP skipped:', e.response?.status || e.message);
        }

        console.log('\n3. Verifying user read...');
        const foundUser = await api.getUserByUsername(username);
        console.log('   Found user:', foundUser ? 'yes' : 'no');

        console.log('\n4. Verifying SIP read...');
        const foundSip = userId ? await api.getSipByUserId(userId) : null;
        console.log('   SIP row for user:', foundSip ? 'yes' : 'no');

        console.log('\n--- Summary ---');
        console.log('User API:', userResult.success ? 'OK' : 'FAIL');
        console.log('SIP API:', foundSip ? 'OK' : 'skipped / no row');
        console.log('\nCore bot flows that only need user module: OK if user step passed.');
    } finally {
        console.log('\n5. Cleaning up...');
        if (userId) {
            try {
                const sipRow = await api.getSipByUserId(userId);
                if (sipRow) {
                    await api.destroy('sip', sipRow.id);
                    console.log('   SIP deleted');
                }
            } catch (e) {
                console.log('   SIP delete:', e.message);
            }
            try {
                await api.destroy('user', userId);
                console.log('   User deleted');
            } catch (e) {
                console.log('   User delete:', e.message);
            }
        }
    }

    console.log('\nDone.');
}

test().catch((e) => {
    console.error(e);
    process.exit(1);
});
