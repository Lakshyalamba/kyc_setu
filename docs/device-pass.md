# Selfie device pass

The selfie screen uses the camera, and cameras behave differently on every browser. The automated browser tests use a canvas
for a camera, so they prove the screen's logic and what it sends, **not** that a real camera works. This is the checklist for
doing that by hand, with the date and the result written down. Nothing below has been run yet: the table is blank on purpose,
and a blank row means "not tested", not "passes".

Run the stack, open `http://<your machine's address>:3000` on the device (a phone needs `https`, or the browser hides the
camera: use a tunnel such as `cloudflared tunnel --url http://localhost:3000`, and set `WEB_ORIGIN` and
`NEXT_PUBLIC_API_URL` to match), sign up, and go through to the selfie step. Use `AI_FACE_BACKEND=stub` to see the screen
without a face, or the real models with your own face.

## Per device

For each device: the camera opens only after tapping "Open camera"; the preview is the front camera and mirrored; the oval is
centred; the countdown shows 3, 2, 1; the screen flashes three times; the progress steps appear; the outcome matches what the
service decided.

| Device        | Browser / version | Date | Camera opens | Preview inline (no full screen) | Three frames sent | Permission denied recovers | Photo upload works | Notes |
| ------------- | ----------------- | ---- | ------------ | ------------------------------- | ----------------- | -------------------------- | ------------------ | ----- |
| iPhone        | Safari            |      |              |                                 |                   |                            |                    |       |
| Android phone | Chrome            |      |              |                                 |                   |                            |                    |       |
| Laptop        | Chrome            |      |              |                                 |                   |                            |                    |       |
| Mac laptop    | Safari            |      |              |                                 |                   |                            |                    |       |

## What to look for, and why

- **iPhone Safari** only plays a camera stream inline if the `<video>` has `playsinline`, `muted` and `autoplay`; without them it
  goes full screen or stays black. Check that. It also asks permission again for each page load unless the person chooses to
  allow for the session. The camera must be started from a tap: it is.
- **Android Chrome** may rotate the preview if the phone is held sideways; frames are cropped to portrait 3:4 either way.
  Check that a rear-camera-only tablet reports "no camera" kindly rather than failing silently.
- **Desktop Chrome** with several cameras uses the default one; there is no picker. Note it if the wrong one opens.
- **Desktop Safari** asks the first time per site and remembers "Allow" in Settings → Websites → Camera: check that a denied
  camera shows the recovery text and that "Try again" works after allowing.

## For every device

1. Deny the permission. The screen should say the camera is blocked and how to unblock it, offer "Try again", and offer
   "Upload a photo instead". After uploading a photo, an officer's review page must say **no motion check was performed**.
2. Cover the camera, or stand in the dark: the checks should end in a retake offer with advice about light, with no accusing words.
3. Hold a still photograph of a face in front of the camera: the motion check should fail with "frames too similar". This is the
   only attack the check catches; it does not catch a replayed video, a mask or a deepfake, and this pass does not claim to.
4. Check the face-detector hint appears (the oval turns green when the face is centred). It is advisory: the button works
   either way.

Record anything unexpected in the Notes column, with the device model and OS version.
