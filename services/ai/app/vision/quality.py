from dataclasses import dataclass, field

import cv2
import numpy as np

# Sharpness is measured on a fixed-width image so the number means the same thing for a 12 MP photo
# and a 1 MP scan.
_NORMALISED_WIDTH = 1000
_TOO_DARK = 60.0
_TOO_BRIGHT = 245.0


@dataclass
class Quality:
    sharpness: float
    brightness: float
    width: int
    height: int
    warnings: list[str] = field(default_factory=list)

    @property
    def blocking(self) -> bool:
        return any(w.startswith(("LOW_SHARPNESS", "LOW_RESOLUTION")) for w in self.warnings)


def measure_quality(image: np.ndarray, *, min_sharpness: float, min_side_px: int) -> Quality:
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if width != _NORMALISED_WIDTH:
        scale = _NORMALISED_WIDTH / width
        interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
        gray_n = cv2.resize(gray, (_NORMALISED_WIDTH, max(int(height * scale), 1)), interpolation=interpolation)
    else:
        gray_n = gray
    sharpness = float(cv2.Laplacian(gray_n, cv2.CV_64F).var())
    brightness = float(gray.mean())

    warnings: list[str] = []
    if sharpness < min_sharpness:
        warnings.append(f"LOW_SHARPNESS ({sharpness:.1f} < {min_sharpness:g})")
    if min(width, height) < min_side_px:
        warnings.append(f"LOW_RESOLUTION (min side {min(width, height)} < {min_side_px})")
    if brightness < _TOO_DARK:
        warnings.append(f"TOO_DARK (brightness {brightness:.0f})")
    elif brightness > _TOO_BRIGHT:
        warnings.append(f"TOO_BRIGHT (brightness {brightness:.0f})")
    return Quality(round(sharpness, 2), round(brightness, 2), width, height, warnings)
