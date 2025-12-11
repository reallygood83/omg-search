#!/usr/bin/env node
/**
 * Test script using Files API + importFile approach
 */

const API_KEY = process.argv[2];
const STORE_NAME = process.argv[3];

if (!API_KEY || !STORE_NAME) {
    console.error('Usage: node test-import.mjs <API_KEY> <FILE_SEARCH_STORE_NAME>');
    process.exit(1);
}

const API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const UPLOAD_BASE_URL = 'https://generativelanguage.googleapis.com/upload/v1beta';

async function testImportWorkflow() {
    console.log('='.repeat(60));
    console.log('Testing Files API + importFile workflow');
    console.log('='.repeat(60));

    const testContent = `# Test Document\n\nCreated at ${new Date().toISOString()}\n\nTest content for Gemini File Search Store.`;
    const testFileName = 'test-import-' + Date.now() + '.md';

    // Step 1: Upload to Files API
    console.log('\n[STEP 1] Uploading to Files API...');
    
    const boundary = 'foo_bar_baz';
    const metadata = JSON.stringify({
        file: {
            displayName: testFileName,
            mimeType: 'text/markdown'
        }
    });

    // Using Google's documented multipart format for Files API
    let body = '';
    body += `--${boundary}\r\n`;
    body += 'Content-Type: application/json; charset=UTF-8\r\n\r\n';
    body += metadata + '\r\n';
    body += `--${boundary}\r\n`;
    body += 'Content-Type: text/markdown\r\n\r\n';
    body += testContent + '\r\n';
    body += `--${boundary}--`;

    const uploadUrl = `${UPLOAD_BASE_URL}/files?key=${API_KEY}`;
    console.log('[STEP 1] URL:', uploadUrl.replace(API_KEY, 'KEY'));

    try {
        const uploadResponse = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body: body
        });

        console.log('[STEP 1] Status:', uploadResponse.status, uploadResponse.statusText);
        const uploadData = await uploadResponse.json();
        console.log('[STEP 1] Response:', JSON.stringify(uploadData, null, 2));

        if (uploadResponse.status >= 200 && uploadResponse.status < 300 && uploadData.file) {
            console.log('✅ File uploaded successfully!');
            const fileName = uploadData.file.name;
            console.log('[STEP 1] File name:', fileName);

            // Step 2: Import to FileSearchStore
            console.log('\n[STEP 2] Importing to FileSearchStore...');
            const importUrl = `${API_BASE_URL}/${STORE_NAME}:importFile?key=${API_KEY}`;
            console.log('[STEP 2] URL:', importUrl.replace(API_KEY, 'KEY'));

            const importResponse = await fetch(importUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    fileName: fileName
                })
            });

            console.log('[STEP 2] Status:', importResponse.status, importResponse.statusText);
            const importData = await importResponse.json();
            console.log('[STEP 2] Response:', JSON.stringify(importData, null, 2));

            if (importResponse.status >= 200 && importResponse.status < 300) {
                console.log('\n' + '='.repeat(60));
                console.log('✅ SUCCESS! Import workflow completed.');
                console.log('='.repeat(60));
            } else {
                console.log('\n' + '='.repeat(60));
                console.log('❌ FAILED! Import step failed.');
                console.log('='.repeat(60));
            }
        } else {
            console.log('\n' + '='.repeat(60));
            console.log('❌ FAILED! File upload step failed.');
            console.log('='.repeat(60));
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
}

testImportWorkflow();
