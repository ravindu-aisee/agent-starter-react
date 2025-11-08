'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';

interface DetectedImage {
  name: string;
  path: string;
  confidence: number;
  timestamp: number;
}

export default function DetectionsPage() {
  const [images, setImages] = useState<DetectedImage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadImages();
    // Refresh every 5 seconds
    const interval = setInterval(loadImages, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadImages = async () => {
    try {
      const response = await fetch('/api/list-images');
      if (response.ok) {
        const data = await response.json();
        setImages(data.images);
      }
    } catch (error) {
      console.error('Failed to load images:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-xl">Loading detections...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-8">
      <h1 className="mb-8 text-3xl font-bold">Detected Bus Number Plates</h1>

      {images.length === 0 ? (
        <p className="text-gray-500">
          No detections yet. Start the camera to begin detecting bus numbers.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {images.map((img) => (
            <div key={img.name} className="rounded-lg border p-4 shadow-lg">
              <div className="relative mb-3 h-48 w-full rounded bg-gray-100">
                <Image
                  src={img.path}
                  alt={`Detection ${img.name}`}
                  fill
                  className="object-contain"
                />
              </div>
              <div className="space-y-1 text-sm">
                <p className="font-semibold">Confidence: {img.confidence}%</p>
                <p className="text-xs text-gray-600">{new Date(img.timestamp).toLocaleString()}</p>
                <p className="truncate text-xs text-gray-500">{img.name}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
