import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import vision from '@google-cloud/vision';

// Initialize the Vision API client with credentials from environment variables
const client = new vision.ImageAnnotatorClient({
  credentials: {
    client_email: process.env.VISION_OCR_CLIENT_EMAIL,
    private_key: process.env.VISION_OCR_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  projectId: process.env.VISION_OCR_PROJECT_ID,
});

export async function POST(request: NextRequest) {
  try {
    const { image } = await request.json();

    if (!image) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    }

    // Remove data URL prefix if present (e.g., "data:image/jpeg;base64,")
    const base64Image = image.replace(/^data:image\/\w+;base64,/, '');

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Image, 'base64');

    console.log('🔍 Starting OCR text detection...');

    // Perform text detection
    const [result] = await client.textDetection(imageBuffer);
    const detections = result.textAnnotations;

    if (!detections || detections.length === 0) {
      console.log('⚠️ No text detected in image');
      return NextResponse.json({
        success: true,
        text: '',
        detections: [],
        message: 'No text detected in image',
      });
    }

    console.log('✅ Text Detection Results:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // First detection contains all text
    const fullText = detections[0]?.description || '';
    console.log('📄 Full Text:', fullText);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Individual word detections
    console.log('📝 Individual Words:');
    detections.slice(1).forEach((text, index) => {
      console.log(`  ${index + 1}. "${text.description}"`);
    });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return NextResponse.json({
      success: true,
      text: fullText,
      detections: detections.map((detection) => ({
        text: detection.description,
        bounds: detection.boundingPoly,
      })),
      wordCount: detections.length - 1,
    });
  } catch (error) {
    console.error('❌ OCR Error:', error);
    return NextResponse.json(
      {
        error: 'Failed to process image',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
