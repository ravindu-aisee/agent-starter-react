// app/api/save-image/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

export async function POST(request: NextRequest) {
  try {
    const { image, filename } = await request.json();

    if (!image || !filename) {
      return NextResponse.json(
        { success: false, error: 'Missing image or filename' },
        { status: 400 }
      );
    }

    // Define the save directory (public/captured_images)
    const saveDir = join(process.cwd(), 'public', 'captured_images');

    // Create directory if it doesn't exist
    if (!existsSync(saveDir)) {
      await mkdir(saveDir, { recursive: true });
      console.log(`📁 Created directory: ${saveDir}`);
    }

    // Extract base64 data from data URL
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Save the file
    const filePath = join(saveDir, filename);
    await writeFile(filePath, buffer);

    // Return relative path for web access
    const relativePath = `/captured_images/${filename}`;

    console.log(`✅ Image saved successfully: ${relativePath}`);

    return NextResponse.json({
      success: true,
      path: relativePath,
      filename: filename,
      size: buffer.length,
    });
  } catch (error) {
    console.error('❌ Error saving image:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save image',
      },
      { status: 500 }
    );
  }
}
