# Models served to the browser

| File                           | What                                                                     | Licence    | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------ |
| `blaze_face_short_range.tflite` | MediaPipe BlazeFace short-range face detector (float16), from `storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/` | Apache-2.0 | `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f` |

It only draws the "centre your face" hint on the capture screen. Its result is never sent to the server and never counts as
evidence: the motion check and the face match run on the server, on the pictures. The wasm runtime
(`@mediapipe/tasks-vision`, Apache-2.0) is copied to `public/mediapipe/wasm` by `scripts/copy-mediapipe.mjs`.
