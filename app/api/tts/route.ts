// app/api/tts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';

export async function POST(request: NextRequest) {
  try {
    const { text } = await request.json();

    if (!text) {
      return NextResponse.json(
        { success: false, error: 'Missing text parameter' },
        { status: 400 }
      );
    }

    console.log(`TTS Request: "${text}"`);

    // Import Google Cloud TTS (only on server-side)
    const textToSpeech = require('@google-cloud/text-to-speech');

    // Use the same credentials as OCR (vision_ocr.json)
    const credentialsPath = join(process.cwd(), 'vision_ocr.json');

    console.log(`Using credentials from: ${credentialsPath}`);

    const client = new textToSpeech.TextToSpeechClient({
      keyFilename: credentialsPath,
    });

    // Construct the request
    const ttsRequest = {
      input: { text: text },
      // Select the language and SSML voice gender
      voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
      // Select the type of audio encoding
      audioConfig: { audioEncoding: 'MP3' },
    };

    console.log('Calling Google Cloud TTS API...');

    // Performs the text-to-speech request
    const [response] = await client.synthesizeSpeech(ttsRequest);

    if (!response.audioContent) {
      throw new Error('No audio content received from TTS API');
    }

    console.log(`TTS audio generated successfully (${response.audioContent.length} bytes)`);

    // Return the audio content as MP3
    return new NextResponse(response.audioContent, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': response.audioContent.length.toString(),
      },
    });
  } catch (error: any) {
    console.error('TTS Error Details:', {
      message: error?.message,
      code: error?.code,
      details: error?.details,
      stack: error?.stack,
    });

    // Check for common API issues
    let errorMessage = error instanceof Error ? error.message : 'Failed to generate TTS';
    let statusCode = 500;

    if (error?.code === 7 || error?.message?.includes('PERMISSION_DENIED')) {
      errorMessage = 'Text-to-Speech API not enabled. Please enable it in Google Cloud Console.';
      statusCode = 403;
    } else if (error?.message?.includes('API key not valid')) {
      errorMessage = 'Invalid API credentials. Please check vision_ocr.json file.';
      statusCode = 401;
    }

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        details: error?.details || error?.message,
      },
      { status: statusCode }
    );
  }
}
