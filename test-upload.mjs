#!/usr/bin/env node
/**
 * Test script to verify uploadToFileSearchStore API implementation
 * Run: node test-upload.mjs <API_KEY> <FILE_SEARCH_STORE_NAME>
 * Example: node test-upload.mjs AIza... fileSearchStores/my-store-abc123
 */

const API_KEY = process.argv[2];
const STORE_NAME = process.argv[3];

if (!API_KEY || !STORE_NAME) {
    console.error('Usage: node test-upload.mjs <API_KEY> <FILE_SEARCH_STORE_NAME>');
    console.error('Example: node test-upload.mjs AIzaSyXXX fileSearchStores/my-store-123');
    process.exit(1);
}

const UPLOAD_BASE_URL = 'https://generativelanguage.googleapis.com/upload/v1beta';
const API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

async function testUpload() {
    console.log('='.repeat(60));
    console.log('Testing uploadToFileSearchStore API');
    console.log('='.repeat(60));
    console.log(`Store: ${STORE_NAME}`);
    console.log(`API Key: ${API_KEY.substring(0, 10)}...`);
    console.log('');

    // Test content
    const testContent = `# Test Document

This is a test document uploaded at ${new Date().toISOString()}.

## Test Section
- Item 1
- Item 2
- Item 3

The quick brown fox jumps over the lazy dog.
`;

    const testFilePath = 'test-document.md';

    // Build multipart/related body - Google API format with CRLF
    const boundary = 'foo_bar_baz';

    const metadata = JSON.stringify({
        displayName: testFilePath
    });

    // Google's multipart format requires specific structure
    let body = '';
    body += `--${boundary}\r\n`;
    body += 'Content-Type: application/json\r\n\r\n';
    body += metadata + '\r\n';
    body += `--${boundary}\r\n`;
    body += 'Content-Type: text/plain\r\n\r\n';
    body += testContent + '\r\n';
    body += `--${boundary}--`;

    // Alternative: Try with Content-Transfer-Encoding
    console.log('[TEST] Trying format 1: Basic multipart');

    // Also prepare format 2 with octet-stream
    let body2 = '';
    body2 += `--${boundary}\r\n`;
    body2 += 'Content-Type: application/json; charset=UTF-8\r\n\r\n';
    body2 += metadata + '\r\n';
    body2 += `--${boundary}\r\n`;
    body2 += 'Content-Type: application/octet-stream\r\n';
    body2 += 'Content-Transfer-Encoding: binary\r\n\r\n';
    body2 += testContent + '\r\n';
    body2 += `--${boundary}--`;

    const url = `${UPLOAD_BASE_URL}/${STORE_NAME}:uploadToFileSearchStore?key=${API_KEY}`;

    console.log('[TEST] Request URL:', url.replace(API_KEY, 'API_KEY'));
    console.log('[TEST] Content-Type: multipart/related; boundary=' + boundary);
    console.log('[TEST] Body length:', body.length, 'bytes');
    console.log('');

    try {
        console.log('[TEST] Sending request...');
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body: body
        });

        console.log('[TEST] Response status:', response.status, response.statusText);

        const responseText = await response.text();
        let responseData;

        try {
            responseData = JSON.parse(responseText);
            console.log('[TEST] Response JSON:', JSON.stringify(responseData, null, 2));
        } catch {
            console.log('[TEST] Response text:', responseText);
        }

        if (response.status >= 200 && response.status < 300) {
            console.log('');
            console.log('='.repeat(60));
            console.log('✅ SUCCESS! Upload API call succeeded.');
            console.log('='.repeat(60));

            if (responseData && responseData.done === false && responseData.name) {
                console.log('');
                console.log('[TEST] Operation in progress. Polling for completion...');
                await waitForOperation(responseData.name);
            } else if (responseData && responseData.done === true) {
                console.log('[TEST] Operation completed immediately.');
                if (responseData.response) {
                    console.log('[TEST] Document name:', responseData.response.name);
                }
            }
        } else {
            console.log('');
            console.log('='.repeat(60));
            console.log('❌ FAILED! Upload API call failed.');
            console.log('='.repeat(60));
            if (responseData && responseData.error) {
                console.log('Error code:', responseData.error.code);
                console.log('Error message:', responseData.error.message);
                if (responseData.error.details) {
                    console.log('Error details:', JSON.stringify(responseData.error.details, null, 2));
                }
            }
        }

    } catch (error) {
        console.error('[TEST] Request error:', error.message);
        console.log('');
        console.log('='.repeat(60));
        console.log('❌ FAILED! Network or other error.');
        console.log('='.repeat(60));
    }
}

async function waitForOperation(operationName, maxRetries = 10) {
    for (let i = 0; i < maxRetries; i++) {
        const waitTime = Math.min(1000 * Math.pow(1.5, i), 10000);
        console.log(`[TEST] Waiting ${waitTime}ms before checking operation status...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        const url = `${API_BASE_URL}/${operationName}?key=${API_KEY}`;

        try {
            const response = await fetch(url);
            const operation = await response.json();

            console.log(`[TEST] Operation status (attempt ${i + 1}):`, operation.done ? 'DONE' : 'IN_PROGRESS');

            if (operation.done) {
                if (operation.error) {
                    console.log('[TEST] Operation failed:', operation.error);
                    return null;
                }
                console.log('[TEST] Operation completed successfully!');
                if (operation.response) {
                    console.log('[TEST] Document:', JSON.stringify(operation.response, null, 2));
                }
                return operation.response;
            }
        } catch (error) {
            console.error(`[TEST] Error checking operation (attempt ${i + 1}):`, error.message);
        }
    }
    console.log('[TEST] Max retries reached.');
    return null;
}

testUpload();
