import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

export async function POST(req: NextRequest) {
  try {
    const { image, filename } = await req.json() as { image: string; filename: string; };

    if (!image || !filename) {
      return NextResponse.json({ error: 'Missing image or filename' }, { status: 400 });
    }

    // Ensure we always write under /public
    const publicDir = path.join(process.cwd(), 'public');
    const safeRelPath = filename.replace(/^\/+/, ''); // strip leading slashes
    const fullPath = path.join(publicDir, safeRelPath);

    // Ensure directory exists (e.g., public/captured_images)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    // image is a data URL (e.g., 'data:image/jpeg;base64,...')
    const base64 = image.split(';base64,').pop();
    if (!base64) {
      return NextResponse.json({ error: 'Invalid data URL' }, { status: 400 });
    }

    fs.writeFileSync(fullPath, Buffer.from(base64, 'base64'));

    // Return public URL path for client display if needed
    const publicUrl = '/' + safeRelPath.replace(/\\/g, '/');
    return NextResponse.json({ ok: true, path: publicUrl });
  } catch (e: any) {
    console.error('save-image error:', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
