import { NextResponse } from 'next/server';
import { readdir } from 'fs/promises';
import { join } from 'path';

export async function GET() {
  try {
    const dirPath = join(process.cwd(), 'public', 'captured_images');
    
    // Read all files in the directory
    const files = await readdir(dirPath);
    
    // Filter for image files and parse metadata
    const images = files
      .filter(file => file.startsWith('detected_') && file.endsWith('.jpg'))
      .map(file => {
        // Parse filename: detected_[timestamp]_conf[XX].jpg
        const parts = file.match(/detected_(\d+)_conf(\d+)\.jpg/);
        
        if (parts) {
          const timestamp = parseInt(parts[1]);
          const confidence = parseInt(parts[2]);
          
          return {
            name: file,
            path: `/captured_images/${file}`,
            confidence,
            timestamp,
          };
        }
        
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => (b?.timestamp || 0) - (a?.timestamp || 0)); // Sort by newest first

    return NextResponse.json({
      success: true,
      count: images.length,
      images,
    });
  } catch (error) {
    console.error('❌ Error listing images:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to list images',
        images: [] 
      },
      { status: 500 }
    );
  }
}
