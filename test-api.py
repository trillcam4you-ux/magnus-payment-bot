import requests
import time
import hmac
import hashlib
import json

class MagnusBilling:
    def __init__(self, api_key, api_secret, public_url):
        self.api_key = api_key
        self.api_secret = api_secret
        self.public_url = public_url
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/4.0 (compatible; MagnusBilling Python bot; Python)'
        })

    def query(self, req=None):
        if req is None:
            req = {}

        # Generate nonce
        mt = time.time()
        req['nonce'] = f"{int(mt)}{str(mt).split('.')[1][:6]}"

        # Generate POST data string
        post_data = "&".join(f"{key}={value}" for key, value in req.items())
        sign = hmac.new(
            self.api_secret.encode('utf-8'), 
            post_data.encode('utf-8'), 
            hashlib.sha512
        ).hexdigest()

        # Generate headers
        headers = {
            'Key': self.api_key,
            'Sign': sign
        }

        # Construct URL
        module = req.get('module')
        action = req.get('action')
        url = f"{self.public_url}/index.php/{module}/{action}"

        print(f"URL: {url}")
        print(f"Post Data: {post_data}")
        print(f"Sign: {sign[:30]}...")

        # Send POST request
        response = self.session.post(url, data=req, headers=headers, verify=False)

        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            try:
                print(f"Response: {json.dumps(response.json())[:300]}")
            except:
                print(f"Response: {response.text[:200]}")
        else:
            print(f"Error: {response.text[:200]}")

        return response

# Test with your credentials
api = MagnusBilling(
    "sk-9f3A7xQ2LmZ8P0vR4tYbH1KcW6eJdS5u",
    "APISECRET-sec_4Hk9ZqP2xW8Lm7TgY5vR3cN1aF6JdS0B",
    "http://172.235.137.54/mbilling"
)

# Test read
print("Testing user/read...")
api.query({
    'module': 'user',
    'action': 'read',
    'page': 1,
    'start': 0,
    'limit': 25,
    'filter': '[]'
})
