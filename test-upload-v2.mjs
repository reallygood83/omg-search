#!/usr/bin/env node
/**
 * Test using uploadType=multipart with form-data style
 */

const API_KEY = process.argv[2];
const STORE_NAME = process.argv[3];

if (!API_KEY || !STORE_NAME) {
    console.error('Usage: node test-upload-v2.mjs <API_KEY> <FILE_SEARCH_STORE_NAME>');
    process.exit(1);
}

const UPLOAD_BASE_URL = 'https://generativelanguage.googleapis.com/upload/v1beta';
const API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

async function testUpload() {
    console.log('='.repeat(60));
    console.log('Testing Files API with uploadType=multipart');
    console.log('='.repeat(60));

    const testContent = `# Test Document\n\nCreated at ${new Date().toISOString()}\n\nTest content for Gemini File Search Store.`;
    const testFileName = 'test-' + Date.now() + '.md';

    // Step 1: Upload to Files API with uploadType=multipart
    console.log('\n[STEP 1] Uploading to Files API with uploadType=multipart...');
    
    const uploadUrl = `${UPLOAD_BASE_URL}/files?uploadType=multipart&key=${API_KEY}`;
    console.log('[STEP 1] URL:', uploadUrl.replace(API_KEY, 'KEY'));

    // Use FormData for multipart/form-data style
    const formData = new FormData();
    
    // Metadata blob
    const metadata = JSON.stringify({
        file: {
            displayName: testFileName,
            mimeType: 'text/markdown'
        }
    });
    formData.append('metadata', new Blob([metadata], { type: 'application/json' }));
    
    // File content blob
    const fileBlob = new Blob([testContent], { type: 'text/markdown' });
    formData.append('file', fileBlob, testFileName);

    try {
        const uploadResponse = await fetch(uploadUrl, {
            method: 'POST',
            body: formData
        });

        console.log('[STEP 1] Status:', uploadResponse.status, uploadResponse.statusText);
        const responseText = await uploadResponse.text();
        console.log('[STEP 1] Response:', responseText);

        let uploadData;
        try {
            uploadData = JSON.parse(responseText);
        } catch (e) {
            console.log('[STEP 1] Could not parse JSON');
            return;
        }

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
            const importText = await importResponse.text();
            console.log('[STEP 2] Response:', importText);

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
        console.error('Stack:', error.stack);
    }
}

testUpload();
