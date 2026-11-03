export interface Crop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** The centred region of a source that fills a destination of the given aspect without distortion ("object-fit: cover"). */
export function coverCrop(srcW: number, srcH: number, dstW: number, dstH: number): Crop {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    const sw = srcH * dstAspect;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  const sh = srcW / dstAspect;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}
