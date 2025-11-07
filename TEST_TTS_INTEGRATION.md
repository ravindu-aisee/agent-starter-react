# TTS Integration - Test & Verification Guide

## Changes Applied ✅

### 1. **Updated TTS Function (`playTTSAnnouncement`)**

Based on your working code, I've implemented:

- ✅ **Prevent duplicate announcements** - Checks `announcedBusesRef` before playing
- ✅ **Mark as announced BEFORE API call** - Prevents race conditions
- ✅ **Proper Promise handling** - Returns Promise<void> for async/await
- ✅ **Audio event listeners** - Sets up `onended` and `onerror` before playing
- ✅ **URL cleanup** - Revokes blob URLs after playback
- ✅ **Error handling** - Removes from announced set on failure for retry
- ✅ **30-second timeout** - Prevents memory leaks from stuck audio

### 2. **Updated Match Detection Flow**

```typescript
if (isBusMatch) {
  console.log(`✅ MATCH FOUND! Bus "${ocrText}" has arrived!`);

  // Stop detection immediately
  matchFoundRef.current = true;
  stopLoop();

  // Send success response
  sendResponse(`Bus number ${ocrText} detected successfully!`);

  // Play TTS (non-blocking promise chain)
  playTTSAnnouncement(ocrText)
    .then(() => {
      console.log('✅ TTS playback completed');
      // Close camera after 500ms delay
      setTimeout(() => setShowCamera(false), 500);
    })
    .catch((err) => {
      console.error('❌ TTS failed:', err);
      // Close camera anyway
      setTimeout(() => setShowCamera(false), 1000);
    });
}
```

### 3. **Key Improvements Over Previous Implementation**

| Aspect               | Before       | After (Working Code Pattern)                          |
| -------------------- | ------------ | ----------------------------------------------------- |
| Duplicate prevention | ✅ Has check | ✅ Check + mark BEFORE API call                       |
| Promise handling     | Incomplete   | ✅ Proper async/await with resolve/reject             |
| Camera close timing  | Immediate    | ✅ After TTS completes (500ms delay)                  |
| Error recovery       | Partial      | ✅ Full error handling with retry logic               |
| Audio cleanup        | Basic        | ✅ Multiple cleanup paths (onended, onerror, timeout) |

## Testing Instructions

### Manual Test

1. Start your Next.js dev server
2. Send a bus number query through the data channel
3. Point camera at a bus number plate matching the query
4. When match is detected, you should:
   - See console log: `🔊 Playing TTS: "Bus XXX has arrived."`
   - Hear the TTS announcement
   - See console log: `🎵 TTS playback finished`
   - Camera closes after announcement completes

### Test the TTS API Directly

Run the test script to verify server-side TTS:

```bash
node test-tts.js
```

Expected output:

```
🧪 Testing Google Cloud TTS...
✅ SUCCESS! Received 22848 bytes of audio
💾 Saved audio to: test-tts-output.mp3
✅ TTS API is working correctly!
```

### Console Logs to Watch For

**Successful TTS Flow:**

```
🔊 Playing TTS: "Bus 382W has arrived."
📞 Calling /api/tts endpoint...
📡 TTS API Response: 200 OK
📦 Received audio blob: 22848 bytes, type: audio/mpeg
▶️ Playing audio...
✅ Audio playback started successfully
🎵 TTS playback finished
✅ TTS playback completed
```

**If TTS Fails:**

```
❌ TTS announcement failed for bus 382W:
Error details: { message: "...", stack: "..." }
```

## Browser Compatibility

### Audio Autoplay Policy

Some browsers block autoplay. If audio doesn't play:

1. **Chrome/Edge**: Requires user interaction first
2. **Safari**: Stricter autoplay policies
3. **Mobile browsers**: May require user gesture

### Workaround

If autoplay is blocked, the code handles it gracefully:

- Error is logged but doesn't crash the app
- Camera still closes after a delay
- User can retry detection

## Debugging Tips

### Check Browser Console

1. Open DevTools (F12)
2. Go to Console tab
3. Look for TTS-related logs with emoji indicators:
   - 🔊 = TTS request initiated
   - 📞 = API call
   - 📡 = Response received
   - 📦 = Audio blob received
   - ▶️ = Playing audio
   - 🎵 = Playback finished
   - ❌ = Error

### Network Tab

1. Open DevTools Network tab
2. Filter by "tts"
3. Check the POST request to `/api/tts`
4. Verify response is 200 OK with audio/mpeg content

### Common Issues & Solutions

| Issue                  | Cause                       | Solution                             |
| ---------------------- | --------------------------- | ------------------------------------ |
| No audio plays         | Autoplay blocked            | User must interact first             |
| TTS repeats            | Duplicate prevention failed | Check `announcedBusesRef`            |
| Camera closes too fast | Timing issue                | Delay is set to 500ms after TTS      |
| Empty audio blob       | API error                   | Check server logs for TTS API issues |
| Memory leak            | URL not revoked             | Code has 3 cleanup paths             |

## Files Modified

- ✅ `components/app/CameraComponent.tsx` - Main TTS integration
- ✅ `app/api/tts/route.ts` - Enhanced error handling
- ✅ `test-tts.js` - Server-side TTS verification script

## Next Steps

1. Test with real bus number detection
2. Verify TTS plays correctly
3. Check camera closes after announcement
4. Monitor for any memory leaks
5. Test on mobile devices

---

**Status: Ready for Testing** 🚀
