const axios = require('axios');

const MAGNUS_URL = 'http://172.235.137.54/mbilling';

async function loginAndGetToken() {
    try {
        // Create a session to maintain cookies
        const session = axios.create({
            timeout: 10000,
            maxRedirects: 5,
            validateStatus: () => true // Accept all status codes
        });

        // Step 1: Get initial page to capture cookies
        console.log('Step 1: Getting login page...');
        const initialResponse = await session.get(`${MAGNUS_URL}/index.php/authentication/login`);
        
        console.log('Initial response status:', initialResponse.status);
        const cookies = initialResponse.headers['set-cookie'];
        console.log('Cookies received:', cookies);

        // Step 2: Try to login with form data
        console.log('\nStep 2: Attempting login...');
        
        const params = new URLSearchParams();
        params.append('username', 'root');
        params.append('password', 'SSuperman12$');
        
        const response = await session.post(
            `${MAGNUS_URL}/index.php/authentication/login`,
            params,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/javascript, */*'
                }
            }
        );
        
        console.log('Login response status:', response.status);
        console.log('Login response headers:', JSON.stringify(response.headers, null, 2).substring(0, 800));
        console.log('Login response data:', JSON.stringify(response.data).substring(0, 500));
        
        // Check if we got a session
        if (response.status === 200) {
            console.log('\n✅ Login successful!');
            console.log('Session cookies:', response.headers['set-cookie']);
            
            // Step 3: Try to access API with session
            console.log('\nStep 3: Testing API access with session...');
            const apiResponse = await session.get(`${MAGNUS_URL}/index.php/api/read`);
            console.log('API response status:', apiResponse.status);
            console.log('API response:', JSON.stringify(apiResponse.data).substring(0, 500));
            
        } else {
            console.log('\n❌ Login failed with status:', response.status);
        }
        
    } catch (error) {
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
    }
}

loginAndGetToken();
