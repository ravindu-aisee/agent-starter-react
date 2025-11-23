import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import vision from '@google-cloud/vision';

// Client is initialized once and reused across requests
const client = new vision.ImageAnnotatorClient({
  credentials: {
    client_email: process.env.VISION_OCR_CLIENT_EMAIL,
    private_key: process.env.VISION_OCR_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  projectId: process.env.VISION_OCR_PROJECT_ID,
});

// Mark as dynamic to prevent static optimization (ensures client persists)
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // Use Node.js runtime for better performance with Google Vision

export async function POST(request: NextRequest) {
  const startTime = performance.now();
  try {
    // Check if request was aborted before processing
    if (request.signal?.aborted) {
      console.log('OCR request aborted before processing');
      return NextResponse.json(
        { error: 'Request aborted', success: false, text: 'None' },
        { status: 499 }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch (jsonError) {
      // Handle JSON parse errors (usually from aborted requests)
      if (request.signal?.aborted) {
        console.log('OCR request aborted during JSON parsing');
        return NextResponse.json(
          { error: 'Request aborted', success: false, text: 'None' },
          { status: 499 }
        );
      }
      console.error('OCR JSON parse error:', jsonError);
      return NextResponse.json(
        { error: 'Invalid JSON in request body', success: false },
        { status: 400 }
      );
    }

    const { image } = body;

    if (!image) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    }

    // Remove data URL prefix if present (e.g., "data:image/jpeg;base64,")
    const base64Image = image.replace(/^data:image\/\w+;base64,/, '');

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Image, 'base64');

    console.log('Starting OCR text detection...');

    // Perform text detection
    const [result] = await client.textDetection(imageBuffer);
    const detections = result.textAnnotations;

    if (!detections || detections.length === 0) {
      console.log(' No text detected in image');
      return NextResponse.json({
        success: true,
        text: '',
        detections: [],
        message: 'No text detected in image',
      });
    }

    console.log('-----------Text Detection Results:');

    // First detection contains all text
    const fullText = detections[0]?.description || '';

    detections.slice(1).forEach((text, index) => {
    });

    // Extract individual words (excluding the first full-text detection)
    const individualWords = detections
      .slice(1)
      .map((d) => d.description || '')
      .filter((w) => w.trim());
    console.log('Individual Words Array:', individualWords);

    const totalTime = performance.now() - startTime;
    console.log(`Total OCR processing time: ${totalTime.toFixed(2)}ms`);

    return NextResponse.json({
      success: true,
      text: fullText,
      individualWords,
      detections: detections.map((detection) => ({
        text: detection.description,
        bounds: detection.boundingPoly,
      })),
      wordCount: detections.length - 1,
      processingTime: totalTime,
    });
  } catch (error) {
    console.error('OCR Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to process image',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
