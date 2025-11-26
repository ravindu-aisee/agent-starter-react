// /**
//  * OCR API Warmup Utility
//  *
//  * Pre-warms the OCR API route to avoid cold start latency on first real request.
//  * This creates a minimal dummy request to trigger Next.js compilation and
//  * Google Vision client initialization.
//  */

// let warmupComplete = false;
// let warmupPromise: Promise<void> | null = null;

// export async function warmupOCRAPI(): Promise<void> {
//   // Return immediately if already warmed up
//   if (warmupComplete) {
//     console.log('OCR API already warmed up');
//     return;
//   }

//   // Return existing promise if warmup is in progress
//   if (warmupPromise) {
//     console.log('OCR API warmup already in progress...');
//     return warmupPromise;
//   }

//   console.log('Warming up OCR API...');

//   warmupPromise = (async () => {
//     try {
//       // Create a minimal 1x1 pixel transparent PNG as warmup payload
//       const dummyImage =
//         'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

//       const response = await fetch('/api/ocr', {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//         },
//         body: JSON.stringify({ image: dummyImage }),
//       });

//       if (response.ok) {
//         warmupComplete = true;
//         console.log('OCR API warmed up successfully');
//       } else {
//         console.warn('OCR API warmup returned non-OK status:', response.status);
//       }
//     } catch (error) {
//       console.error('OCR API warmup failed:', error);
//       // Don't set warmupComplete to true on error, allow retry
//     } finally {
//       warmupPromise = null;
//     }
//   })();

//   return warmupPromise;
// }

// export function isOCRAPIWarmedUp(): boolean {
//   return warmupComplete;
// }
