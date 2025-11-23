// app/api/tts/route.ts
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // TTS should never be statically optimized/cached

// Import Google Cloud TTS
const textToSpeech = require('@google-cloud/text-to-speech')


// Use credentials from environment variables
const client = new textToSpeech.TextToSpeechClient({
  credentials: {
    client_email: process.env.VISION_OCR_CLIENT_EMAIL,
    private_key: process.env.VISION_OCR_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  projectId: process.env.VISION_OCR_PROJECT_ID,
});

type TTSBody = { text?: string };

export async function POST(request: NextRequest) {
  const requestStartTime = performance.now();
  try {
    const { text } = await request.json() as TTSBody;

    if (!text || !text.trim()) {
      return NextResponse.json(
        { success: false, error: 'Missing text parameter' },
        { status: 400 }
      );
    }

    console.log(`TTS Request: "${text}"`);

    // Construct the request
    const ttsRequest = {
      input: { text: text },
      // Select the language and SSML voice gender
      voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
      // Select the type of audio encoding
      audioConfig: { audioEncoding: 'MP3' },
    };

    console.log('Calling Google Cloud TTS API...');
    const apiCallStart = performance.now();

    // Performs the text-to-speech request
    const [response] = await client.synthesizeSpeech(ttsRequest);

    if (!response.audioContent) {
      throw new Error('No audio content received from TTS API');
    }

    const apiCallTime = performance.now() - apiCallStart;
    const totalTime = performance.now() - requestStartTime;
    console.log(
      `TTS audio generated successfully in ${totalTime.toFixed(2)}ms)`
    );

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
      errorMessage = 'Invalid API credentials. Please check your environment variables.';
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
