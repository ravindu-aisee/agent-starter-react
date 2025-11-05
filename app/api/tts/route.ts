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

    console.log(`🔊 TTS Request: "${text}"`);

    // Import Google Cloud TTS (only on server-side)
    const textToSpeech = require('@google-cloud/text-to-speech');

    // Use the same credentials as OCR (vision_ocr.json)
    const credentialsPath = join(process.cwd(), 'vision_ocr.json');
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

    // Performs the text-to-speech request
    const [response] = await client.synthesizeSpeech(ttsRequest);

    if (!response.audioContent) {
      throw new Error('No audio content received from TTS API');
    }

    console.log('✅ TTS audio generated successfully');

    // Return the audio content as MP3
    return new NextResponse(response.audioContent, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': response.audioContent.length.toString(),
      },
    });
  } catch (error) {
    console.error('❌ TTS Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate TTS',
      },
      { status: 500 }
    );
  }
}
